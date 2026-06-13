# Side-by-side RAM comparison.
#
# Tauri's WebView2 renderer processes are spawned by the Edge runtime
# host, NOT by the Tauri exe, so ParentProcessId doesn't reveal them.
# We match on the commandline instead (Tauri passes the app user-data
# dir, which contains "deploy" / "com.deploytools").

function Sum-ByCmdline([string]$mainName, [string[]]$cmdTokens) {
  $totalWS = 0; $totalPriv = 0; $count = 0

  $mains = Get-Process -Name $mainName -ErrorAction SilentlyContinue
  foreach ($p in $mains) {
    $totalWS   += $p.WorkingSet64
    $totalPriv += $p.PrivateMemorySize64
    $count++
  }

  # Scan all webview / helper processes for matching commandline.
  $webviews = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
  foreach ($w in $webviews) {
    if (-not $w.CommandLine) { continue }
    $hit = $false
    foreach ($tok in $cmdTokens) {
      if ($w.CommandLine -match [regex]::Escape($tok)) { $hit = $true; break }
    }
    if (-not $hit) { continue }
    $rt = Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue
    if ($rt) {
      $totalWS   += $rt.WorkingSet64
      $totalPriv += $rt.PrivateMemorySize64
      $count++
    }
  }
  return @{ ws = $totalWS; priv = $totalPriv; count = $count }
}

function Sum-Plain([string]$name) {
  $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
  if (-not $procs) { return $null }
  $totalWS = 0; $totalPriv = 0; $count = 0
  foreach ($p in $procs) {
    $totalWS   += $p.WorkingSet64
    $totalPriv += $p.PrivateMemorySize64
    $count++
  }
  return @{ ws = $totalWS; priv = $totalPriv; count = $count }
}

function Print-App([string]$label, $r) {
  if (-not $r -or $r.count -eq 0) {
    "{0,-20} not running" -f $label
    return
  }
  "{0,-20} {1,9:N1} MB WS  |  {2,9:N1} MB Private  ({3} proc{4})" -f `
    $label, ($r.ws / 1MB), ($r.priv / 1MB), $r.count,
    $(if ($r.count -eq 1) { "" } else { "s" })
}

""
# Auto Deployment = main exe + its WebView2 children (matched by cmdline).
Print-App "Auto Deployment" (Sum-ByCmdline "deploy-tools" @("deploy", "com.deploytools"))
Print-App "PyCharm"         (Sum-Plain     "pycharm64")
""
