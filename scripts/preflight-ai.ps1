#!/usr/bin/env pwsh
# Preflight check for AI work on Sales Claw.
# Run at the start of every new session before touching code.
#
# Verifies:
#   - working directory is the main repo, not a worktree
#   - no orphan worktrees from prior agent sessions
#   - working tree is clean or only has known-WIP changes
#   - no stale cmd.exe / node.exe lingering from earlier runs
#   - no other Claude Code session has --add-dir on a worktree
#   - installed Sales Claw matches the package.json version
#
# Exit code 0 on clean preflight, 1 on warnings (does not auto-fix —
# call 'npm run clean:workspace' to fix what it can).
#
# Usage: npm run preflight  (or  powershell -File scripts/preflight-ai.ps1)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

function Write-Section($name) {
  Write-Host ""
  Write-Host ("=== {0} ===" -f $name) -ForegroundColor Cyan
}

function Write-Ok($msg) {
  Write-Host ("  OK  {0}" -f $msg) -ForegroundColor Green
}

function Write-Warn($msg) {
  Write-Host ("  !!  {0}" -f $msg) -ForegroundColor Yellow
}

function Write-Bad($msg) {
  Write-Host ("  XX  {0}" -f $msg) -ForegroundColor Red
}

$warningCount = 0

# 1. Working directory check
Write-Section "1. Working directory"
$cwd = (Get-Location).Path
if ($cwd -match '\.claude\\worktrees\\') {
  Write-Bad ("cwd is inside a worktree: {0}" -f $cwd)
  Write-Bad "Open a fresh shell at the repo root before continuing."
  $warningCount++
} else {
  Write-Ok ("cwd = {0}" -f $cwd)
}

# 2. Worktree orphan check
Write-Section "2. Git worktrees"
$worktrees = git worktree list --porcelain 2>$null
$wtPaths = @()
foreach ($line in $worktrees) {
  if ($line -match '^worktree\s+(.+)$') { $wtPaths += $Matches[1] }
}
$orphans = $wtPaths | Where-Object { $_ -match '\.claude/worktrees/' -and $_ -notmatch [regex]::Escape($repoRoot.Replace('\','/')) }
$mainWorktrees = $wtPaths | Where-Object { $_ -notmatch '\.claude/worktrees/' }

if ($orphans.Count -eq 0) {
  Write-Ok ("only main worktree tracked ({0})" -f ($mainWorktrees -join ', '))
} else {
  Write-Warn ("{0} agent worktree(s) tracked:" -f $orphans.Count)
  foreach ($wt in $orphans) { Write-Host ("       {0}" -f $wt) -ForegroundColor DarkYellow }
  Write-Warn "  -> review with 'git log --oneline main..claude/<name>' for unique commits"
  Write-Warn "  -> run 'npm run clean:workspace' to remove unused ones"
  $warningCount++
}

# 3. Working tree state
Write-Section "3. Working tree"
$status = git status --short 2>$null
if (-not $status) {
  Write-Ok "working tree clean"
} else {
  $lineCount = ($status | Measure-Object -Line).Lines
  Write-Warn ("{0} uncommitted file(s):" -f $lineCount)
  $status | Select-Object -First 8 | ForEach-Object { Write-Host ("       {0}" -f $_) -ForegroundColor DarkYellow }
  if ($lineCount -gt 8) { Write-Host "       ..." -ForegroundColor DarkYellow }
  Write-Warn "  -> commit / stash / discard before starting new work"
  $warningCount++
}

# 4. Stale shells / node processes
Write-Section "4. Stale processes (>1 hour old)"
$threshold = (Get-Date).AddHours(-1)
$stale = @()
foreach ($name in @('cmd', 'node')) {
  try {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.StartTime -lt $threshold }
    if ($procs) { $stale += $procs }
  } catch {}
}
if ($stale.Count -eq 0) {
  Write-Ok "no stale shells/node from prior sessions"
} else {
  Write-Warn ("{0} stale process(es) lingering" -f $stale.Count)
  $stale | Select-Object -First 5 | ForEach-Object {
    Write-Host ("       PID {0}  {1}  start={2:HH:mm}" -f $_.Id, $_.ProcessName, $_.StartTime) -ForegroundColor DarkYellow
  }
  Write-Warn "  -> may hold worktree handles. 'npm run clean:workspace' will kill them"
  $warningCount++
}

# 5. Other Claude session holding a worktree
Write-Section "5. Other Claude Code sessions on worktrees"
try {
  $claudeProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -match '\.claude\\worktrees\\' }
  if (-not $claudeProcs) {
    Write-Ok "no other session has --add-dir on a worktree"
  } else {
    Write-Warn ("{0} Claude session(s) using a worktree:" -f ($claudeProcs | Measure-Object).Count)
    foreach ($p in $claudeProcs) {
      $match = [regex]::Match($p.CommandLine, '--add-dir\s+("?)([^"\s]+)\1')
      $dir = if ($match.Success) { $match.Groups[2].Value } else { '<unknown>' }
      Write-Host ("       PID {0}  {1}" -f $p.ProcessId, $dir) -ForegroundColor DarkYellow
    }
    Write-Warn "  -> do NOT kill those processes (will break their session)"
    $warningCount++
  }
} catch {
  Write-Ok "(could not enumerate processes — skipping)"
}

# 6. Installed app vs source version
Write-Section "6. Installed Sales Claw"
$pkg = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$srcVersion = $pkg.version
$installPaths = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Sales Claw\resources\app\package.json'),
  (Join-Path $env:ProgramFiles 'Sales Claw\resources\app\package.json')
)
$installed = $null
foreach ($p in $installPaths) {
  if (Test-Path -LiteralPath $p) {
    $installed = (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json)
    $installed | Add-Member -NotePropertyName _path -NotePropertyValue $p -Force
    break
  }
}
if (-not $installed) {
  Write-Warn "Sales Claw not installed locally — run 'npm run install:win' after dist:win"
  $warningCount++
} elseif ($installed.version -eq $srcVersion) {
  Write-Ok ("source v{0} == installed v{1} ({2})" -f $srcVersion, $installed.version, $installed._path)
} else {
  Write-Warn ("source v{0} != installed v{1}" -f $srcVersion, $installed.version)
  Write-Warn "  -> code changes need rebuild + reinstall before E2E testing"
  $warningCount++
}

# Summary
Write-Section "Summary"
if ($warningCount -eq 0) {
  Write-Host "All preflight checks passed." -ForegroundColor Green
  exit 0
} else {
  Write-Host ("{0} warning(s). Resolve before starting work or run 'npm run clean:workspace'." -f $warningCount) -ForegroundColor Yellow
  exit 1
}
