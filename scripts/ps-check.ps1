"=== deploy-tools ==="
Get-Process deploy-tools -ErrorAction SilentlyContinue | ForEach-Object {
  "PID={0}  StartTime={1}  Uptime={2:mm\:ss}" -f $_.Id, $_.StartTime, ((Get-Date) - $_.StartTime)
}
"=== node (vite dev + tauri CLI) ==="
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  "PID={0}  Uptime={1:mm\:ss}  CPU={2:N1}s" -f $_.Id, ((Get-Date) - $_.StartTime), $_.TotalProcessorTime.TotalSeconds
}
