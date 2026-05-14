#!/usr/bin/env pwsh
# Workspace cleanup for Sales Claw repository.
#
# Safely removes:
#   - root-level test artifacts (*.png, .tmp-*) that should not have been left behind
#   - orphan agent worktree directories with no git tracking
#   - stale cmd.exe / node.exe processes (>1 hour old) that hold worktree handles
#
# Does NOT touch:
#   - main source / src / scripts / dist / node_modules / data / screenshots
#   - currently-active Claude Code sessions or their worktrees
#   - branches with unique commits (only deletes branches whose tip is on main)
#
# Usage: npm run clean:workspace
#        powershell -File scripts/clean-workspace.ps1
#        powershell -File scripts/clean-workspace.ps1 -DryRun

param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$prefix = if ($DryRun) { '[dry-run] ' } else { '' }

function Write-Action($msg) {
  Write-Host ("{0}{1}" -f $prefix, $msg) -ForegroundColor Cyan
}
function Write-Skip($msg) {
  Write-Host ("  skip: {0}" -f $msg) -ForegroundColor DarkGray
}
function Write-Ok($msg) {
  Write-Host ("  done: {0}" -f $msg) -ForegroundColor Green
}

# 1. Remove root-level test artifacts
Write-Action "1. Root-level test artifacts"
$rootJunkPatterns = @('*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.bmp',
                      '.tmp-*.ps1', '.tmp-*.sh', '.tmp-*.cjs', '.tmp-*.js')
$junkFound = 0
foreach ($pat in $rootJunkPatterns) {
  $items = Get-ChildItem -LiteralPath $repoRoot -Filter $pat -File -ErrorAction SilentlyContinue
  foreach ($f in $items) {
    $junkFound++
    if ($DryRun) {
      Write-Host ("  would remove: {0}" -f $f.Name) -ForegroundColor DarkYellow
    } else {
      try {
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
        Write-Ok $f.Name
      } catch {
        Write-Host ("  FAIL: {0} - {1}" -f $f.Name, $_) -ForegroundColor Red
      }
    }
  }
}
if ($junkFound -eq 0) { Write-Skip "nothing to remove" }

# 2. Stale shells / node processes (older than 1 hour)
Write-Action "2. Stale processes (>1 hour old)"
$threshold = (Get-Date).AddHours(-1)
$stale = @()
foreach ($name in @('cmd', 'node')) {
  try {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.StartTime -lt $threshold }
    if ($procs) { $stale += $procs }
  } catch {}
}

# Skip processes whose command line references an active Claude session
$activeWorktrees = @()
try {
  $activeClaudes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -match '\.claude\\worktrees\\' }
  foreach ($p in $activeClaudes) {
    $match = [regex]::Match($p.CommandLine, '--add-dir\s+("?)([^"\s]+)\1')
    if ($match.Success) { $activeWorktrees += $match.Groups[2].Value }
  }
} catch {}

$killCount = 0
foreach ($p in $stale) {
  $cmdLine = ''
  try {
    $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue
    if ($cim) { $cmdLine = $cim.CommandLine }
  } catch {}
  $isActive = $false
  foreach ($wt in $activeWorktrees) {
    if ($cmdLine -and $cmdLine -match [regex]::Escape($wt)) { $isActive = $true; break }
  }
  if ($isActive) {
    Write-Skip ("PID {0} {1} (held by active Claude session)" -f $p.Id, $p.ProcessName)
    continue
  }
  if ($DryRun) {
    Write-Host ("  would stop: PID {0} {1} start={2:HH:mm}" -f $p.Id, $p.ProcessName, $p.StartTime) -ForegroundColor DarkYellow
  } else {
    try {
      Stop-Process -Id $p.Id -Force -ErrorAction Stop
      $killCount++
    } catch {}
  }
}
if ($killCount -gt 0) { Write-Ok ("stopped {0} process(es)" -f $killCount) }
elseif (-not $DryRun -and $stale.Count -eq 0) { Write-Skip "no stale processes" }

# 3. Orphan worktree directories
Write-Action "3. Orphan worktree directories"
$worktreeDir = Join-Path $repoRoot '.claude/worktrees'
if (-not (Test-Path -LiteralPath $worktreeDir)) {
  Write-Skip "no .claude/worktrees directory"
} else {
  $tracked = @()
  $porcelain = git worktree list --porcelain 2>$null
  foreach ($line in $porcelain) {
    if ($line -match '^worktree\s+(.+)$') {
      $p = $Matches[1].Replace('/', '\')
      if ($p -match '\.claude\\worktrees\\([^\\]+)') { $tracked += $Matches[1] }
    }
  }
  $existing = Get-ChildItem -LiteralPath $worktreeDir -Directory -ErrorAction SilentlyContinue
  $removed = 0
  foreach ($d in $existing) {
    if ($tracked -contains $d.Name) {
      Write-Skip ("{0} (tracked worktree)" -f $d.Name)
      continue
    }
    if ($DryRun) {
      Write-Host ("  would remove: .claude/worktrees/{0}" -f $d.Name) -ForegroundColor DarkYellow
    } else {
      try {
        Get-ChildItem -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue |
          ForEach-Object { try { $_.Attributes = 'Normal' } catch {} }
        Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop
        Write-Ok ("removed orphan dir: {0}" -f $d.Name)
        $removed++
      } catch {
        Write-Host ("  FAIL: {0} - still locked" -f $d.Name) -ForegroundColor Red
      }
    }
  }
  if (-not $DryRun -and $removed -eq 0 -and $existing.Count -gt 0) {
    Write-Skip "all worktree dirs are tracked or already gone"
  }
  # Prune git's metadata to clean stale gitdir refs
  if (-not $DryRun) {
    try { git worktree prune 2>$null | Out-Null } catch {}
  }
}

# 4. Branches whose tip is already on main (and not currently checked out)
Write-Action "4. claude/* branches with no unique commits"
$branches = git branch --format '%(refname:short)' 2>$null | Where-Object { $_ -match '^claude/' }

# Build set of branch names that are checked out by an active worktree (cannot be deleted safely)
$activeBranches = @{}
foreach ($line in $porcelain) {
  if ($line -match '^branch\s+refs/heads/(.+)$') { $activeBranches[$Matches[1]] = $true }
}

$deleted = 0
foreach ($b in $branches) {
  if ($activeBranches.ContainsKey($b)) {
    Write-Skip ("{0} (checked out by active worktree)" -f $b)
    continue
  }
  $unique = (git log --oneline ("main.." + $b) 2>$null | Measure-Object -Line).Lines
  if ($unique -eq 0) {
    if ($DryRun) {
      Write-Host ("  would delete: {0}" -f $b) -ForegroundColor DarkYellow
    } else {
      git branch -D $b 2>$null | Out-Null
      Write-Ok ("deleted: {0}" -f $b)
      $deleted++
    }
  } else {
    Write-Skip ("{0} (has {1} unique commit(s))" -f $b, $unique)
  }
}
if (-not $DryRun -and $deleted -eq 0 -and $branches.Count -eq 0) {
  Write-Skip "no claude/* branches"
}

# Summary
Write-Host ""
Write-Host "Cleanup complete." -ForegroundColor Green
if ($DryRun) {
  Write-Host "  (dry-run — no files were actually removed)" -ForegroundColor DarkGray
}
git status --short 2>$null
