"=== stopping deploy-tools + its node dev server ==="
Get-Process deploy-tools -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*DeployTools*' } |
  Stop-Process -Force
"Stopped."
"Now run:  npm run tauri:dev"
