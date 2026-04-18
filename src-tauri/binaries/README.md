# Bundled rsync binaries

Drop platform-specific rsync binaries here so they ship with the app:

- `rsync-x86_64-pc-windows-msvc.exe` — from [cwRsync](https://itefix.net/cwrsync)
- `rsync-aarch64-apple-darwin`       — from Homebrew or `/usr/bin/rsync`
- `rsync-x86_64-unknown-linux-gnu`   — from system package manager

On Windows, the recommended source is the free cwRsync build
(`cwrsync_x.y.z_x64_Free.zip`) — copy `rsync.exe` here and rename it.

If a matching binary is missing at runtime, DeployTools falls back to
`rsync` on the user's `PATH`.
