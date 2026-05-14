param(
  [string]$Installer = "",
  [switch]$AllUsers,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

function Resolve-LatestInstaller {
  param([string]$Root)
  $dist = Join-Path $Root "dist"
  if (-not (Test-Path -LiteralPath $dist)) {
    throw "dist directory not found. Run npm run dist:win first."
  }

  $candidate = Get-ChildItem -LiteralPath $dist -Filter "Sales-Claw-Setup-*.exe" |
    Where-Object { $_.Name -notlike "*.__uninstaller.exe" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $candidate) {
    throw "No Sales-Claw-Setup-*.exe installer found under dist."
  }

  return $candidate.FullName
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($Installer)) {
  $Installer = Resolve-LatestInstaller -Root $repoRoot
} else {
  $Installer = (Resolve-Path -LiteralPath $Installer).Path
}

if ($AllUsers -and -not (Test-Admin)) {
  Write-Host "All-users install requires administrator rights. Requesting UAC elevation..."

  $elevatedArgs = @(
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$PSCommandPath`"",
    "-AllUsers"
  )
  if (-not [string]::IsNullOrWhiteSpace($Installer)) {
    $elevatedArgs += @("-Installer", "`"$Installer`"")
  }
  if ($NoLaunch) {
    $elevatedArgs += "-NoLaunch"
  }

  $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $elevatedArgs -Verb RunAs -Wait -PassThru
  exit $proc.ExitCode
}

$installDir = if ($AllUsers) {
  Join-Path $env:ProgramFiles "Sales Claw"
} else {
  Join-Path $env:LOCALAPPDATA "Programs\Sales Claw"
}

Write-Host "Stopping running Sales Claw processes..."
# ★ "Sales Claw" のみ kill 対象。プロセス名 "electron" を含めていた旧版は
#    VS Code / Discord / Slack 等の他 Electron アプリも巻き添えにしていた。
#    パッケージ版 Sales Claw は electron-builder が productName で
#    binary 名を決定するため、全子プロセス (renderer / GPU / utility) も
#    "Sales Claw" 名で動く。"electron" 名は dev モード時のみ出るが、
#    install スクリプトは packaged installer に対してのみ実行されるので
#    対象外でよい。
Get-Process | Where-Object { $_.ProcessName -eq "Sales Claw" } | Stop-Process -Force -ErrorAction SilentlyContinue

$remaining = Get-Process | Where-Object { $_.ProcessName -eq "Sales Claw" }
if ($remaining) {
  $ids = ($remaining | ForEach-Object { $_.Id }) -join ", "
  throw "Sales Claw is still running and could not be stopped (PID: $ids). Close Sales Claw from the tray/window or run this installer from an elevated PowerShell, then retry."
}

$scopeArg = if ($AllUsers) { "/allusers" } else { "/currentuser" }
$installerArgs = @("/S", $scopeArg, "/D=$installDir")

Write-Host "Installing $Installer"
Write-Host "Target: $installDir"
$proc = Start-Process -FilePath $Installer -ArgumentList $installerArgs -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  throw "Installer failed with exit code $($proc.ExitCode)."
}

$packageJson = Join-Path $installDir "resources\app\package.json"
$appUpdate = Join-Path $installDir "resources\app-update.yml"
if (-not (Test-Path -LiteralPath $packageJson)) {
  throw "Installed package.json was not found at $packageJson"
}
if (-not (Test-Path -LiteralPath $appUpdate)) {
  throw "Installed app-update.yml was not found at $appUpdate"
}

$installed = Get-Content -Raw -LiteralPath $packageJson | ConvertFrom-Json
Write-Host "Installed Sales Claw $($installed.version)"
Write-Host "Update feed:"
Get-Content -LiteralPath $appUpdate | ForEach-Object { Write-Host "  $_" }

if (-not $NoLaunch) {
  $exe = Join-Path $installDir "Sales Claw.exe"
  if (Test-Path -LiteralPath $exe) {
    Start-Process -FilePath $exe
  }
}
