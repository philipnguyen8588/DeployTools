# DeployTools

Desktop app for deploying web projects over SSH — inspired by JetBrains' Deployment tool.

**Stack**: Tauri 2 + Rust backend + React 18 + TypeScript + Tailwind + shadcn/ui + xterm.js

## Features

- Encrypted vault for SSH credentials (Argon2id + AES-256-GCM)
- Multi-tab, multi-session — open many servers at once, JetBrains-style
- Integrated SSH terminal (xterm.js + PTY via russh) that auto-`cd`s to the project's remote path
- JetBrains-style 2-pane file browser (local ↔ remote SFTP)
- Single-file deploy (click any file to upload) or full rsync sync
- Per-project excludes (glob), custom rsync flags
- Host key pinning (TOFU) with mismatch detection
- Dark / light / system theme (terminal palette matches)
- Minimal RAM: target < 150 MB with 3 open sessions

## Prerequisites (Windows)

1. **Node.js 20+** — https://nodejs.org
2. **Rust toolchain** — run in PowerShell:
   ```powershell
   winget install Rustlang.Rustup
   rustup default stable
   ```
3. **Microsoft C++ Build Tools** — install the *Desktop development with C++* workload from https://visualstudio.microsoft.com/visual-cpp-build-tools/
4. **WebView2** — ships with Windows 11; on Windows 10 it's bundled via the Evergreen Bootstrapper in the installer.
5. **(optional) cwRsync** — drop `rsync.exe` in `src-tauri/binaries/rsync-x86_64-pc-windows-msvc.exe` for fully self-contained rsync.

## Run in dev

```bash
npm install
npm run tauri:dev
```

The first `cargo build` pulls ~300 MB of crates and takes a few minutes; subsequent builds are incremental.

## Build production installer

```bash
npm run tauri:build
```

Output: `src-tauri/target/release/bundle/msi/DeployTools_0.1.0_x64_en-US.msi`.

## Security notes

- The master password is **never stored**. Forgot it = lose the vault.
- Credentials (password / key passphrase) are encrypted at rest. `cargo run` → inspect `%APPDATA%\com.deploytools.app\vault.enc` with a hex editor — only ciphertext + salt + nonce.
- Host keys are pinned on first connect. If a server's key changes, the app refuses to connect until you delete the stored fingerprint.
- All rsync arguments are passed as a `Vec<String>` to prevent shell injection.
- The Tauri CSP blocks all remote content; no external domains are reachable from the webview.

## Testing locally

Spin up an SSH server in Docker:
```bash
docker run -d --name sshd -p 2222:22 \
  -e USER_NAME=dev -e USER_PASSWORD=dev \
  -e PASSWORD_ACCESS=true \
  -e SUDO_ACCESS=true \
  linuxserver/openssh-server:latest
```

In the app, add a server: `host=localhost`, `port=2222`, `user=dev`, `password=dev`. Run **Test connection** to pin the host key.

## Running tests

```bash
cd src-tauri
cargo test
```

Key tests:
- `vault::crypto` — Argon2id + AES-GCM round-trip
- `vault::Vault` — init / unlock / change-password / tamper-detect
- `ssh::sftp::validate_remote_path` — path-traversal guard
- `models::Secret` — debug output is redacted

## Project layout

```
src-tauri/src/
├── commands/   # Tauri IPC handlers (one file per domain)
├── vault/      # Argon2id + AES-GCM encrypted config file
├── ssh/        # russh client, session pool, PTY, SFTP
├── rsync/      # rsync subprocess runner with streamed logs
├── models.rs   # Server, Project, VaultData, Secret
├── state.rs    # AppState (vault + session pool)
├── errors.rs   # AppError — serialized across IPC
└── lib.rs      # Tauri entry + invoke_handler list

src/
├── components/ # React components
├── stores/     # Zustand stores
├── lib/        # API wrapper, TS types, utils
└── App.tsx     # Top-level shell
```

## License

MIT
