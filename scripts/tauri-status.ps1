$p = Get-Process deploy-tools -ErrorAction SilentlyContinue
if (-not $p) { "deploy-tools is not running"; return }

# Build a {pid -> parentPid} map once via `wmic` (fast).
$parentMap = @{}
$rows = wmic process get ProcessId,ParentProcessId 2>$null
foreach ($row in $rows) {
  $parts = ($row -split '\s+') | Where-Object { $_ -match '^\d+$' }
  if ($parts.Count -ge 2) {
    # wmic prints ParentProcessId first, ProcessId second.
    $parentMap[[int]$parts[1]] = [int]$parts[0]
  }
}

# Walk descendants by following parent chain for every process.
function Get-AllDescendantPids([int[]]$roots, $parentMap) {
  $rootSet = @{}
  foreach ($r in $roots) { $rootSet[$r] = $true }
  $descendants = @{}
  foreach ($procId in $parentMap.Keys) {
    $cursor = $parentMap[$procId]
    $seen = @{}
    while ($cursor -and -not $seen.ContainsKey($cursor)) {
      $seen[$cursor] = $true
      if ($rootSet.ContainsKey($cursor)) { $descendants[$procId] = $true; break }
      if (-not $parentMap.ContainsKey($cursor)) { break }
      $cursor = $parentMap[$cursor]
    }
  }
  return $descendants.Keys
}

"Main process:"
$mainTotal = 0
foreach ($proc in $p) {
  $mainTotal += $proc.WorkingSet64
  "  PID {0,-6}  WS {1,7:N1} MB  Private {2,7:N1} MB  Threads {3,3}" -f `
    $proc.Id, ($proc.WorkingSet64 / 1MB), ($proc.PrivateMemorySize64 / 1MB), $proc.Threads.Count
}

$descendantPids = Get-AllDescendantPids @($p.Id) $parentMap
""
"WebView2 / helper children of THIS Tauri app:"
$childTotal = 0
foreach ($dProcId in $descendantPids) {
  $rt = Get-Process -Id $dProcId -ErrorAction SilentlyContinue
  if ($rt) {
    $childTotal += $rt.WorkingSet64
    "  PID {0,-6}  WS {1,7:N1} MB  {2}" -f $dProcId, ($rt.WorkingSet64 / 1MB), $rt.ProcessName
  }
}

""
"============================================"
"  Tauri main:          {0,7:N1} MB" -f ($mainTotal / 1MB)
"  WebView2 + helpers:  {0,7:N1} MB" -f ($childTotal / 1MB)
"  --------------------------------"
"  APP TOTAL:           {0,7:N1} MB" -f (($mainTotal + $childTotal) / 1MB)
"============================================"
