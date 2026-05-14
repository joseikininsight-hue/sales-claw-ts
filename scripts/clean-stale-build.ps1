$ErrorActionPreference = 'Continue'
$srcRoot = 'C:\bp-outreach-ts\src'
$deleted = 0
Get-ChildItem -Path $srcRoot -Recurse -File | ForEach-Object {
  $file = $_
  if ($file.FullName -like '*\ui\client-scripts\*') { return }
  $name = $file.Name
  $isJs    = $file.Extension -eq '.js'
  $isJsMap = $name.EndsWith('.js.map')
  if (-not ($isJs -or $isJsMap)) { return }
  $tsPath = $file.FullName -replace '\.js(\.map)?$', '.ts'
  if (Test-Path -LiteralPath $tsPath) {
    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    $deleted++
  }
}
foreach ($p in @(
  'C:\bp-outreach-ts\electron-main.js',
  'C:\bp-outreach-ts\electron-main.js.map',
  'C:\bp-outreach-ts\.tsbuildinfo'
)) {
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    $deleted++
  }
}
Write-Output ("deleted=" + $deleted)
