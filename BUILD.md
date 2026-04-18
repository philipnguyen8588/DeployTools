# Build & run — bước-bước cho Windows

## 1. Cài prerequisites

```powershell
# Rust (rustup)
winget install --id Rustlang.Rustup -e
rustup default stable

# Visual Studio Build Tools (chọn workload "Desktop development with C++")
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Đóng và mở lại terminal để PATH có `cargo`.

Kiểm tra:
```powershell
node --version    # >= 20
cargo --version   # >= 1.75
```

## 2. Cài dependencies

```powershell
cd D:\Projects\Personal\PycharmProjects\DeployTools
npm install
```

## 3. Chạy dev

```powershell
npm run tauri:dev
```

Lần đầu `cargo` sẽ tải ~300 MB crates và compile 3-5 phút. Các lần sau là incremental.

## 4. (Tùy chọn) Bundle cwRsync

Vào https://itefix.net/cwrsync → tải bản Free → giải nén → copy `rsync.exe` vào:
```
src-tauri\binaries\rsync-x86_64-pc-windows-msvc.exe
```

Nếu không làm bước này, app sẽ dùng `rsync` trong PATH (yêu cầu cài từ WSL hoặc Git Bash).

## 5. Tạo icon

```powershell
# 1 file PNG nguồn 1024x1024 -> sinh toàn bộ formats
npx tauri icon path\to\source.png
```

## 6. Build release

```powershell
npm run tauri:build
```

Output: `src-tauri\target\release\bundle\msi\DeployTools_0.1.0_x64_en-US.msi`

---

## Chạy test

```powershell
cd src-tauri
cargo test
```

## Test với SSH server local (Docker)

```powershell
docker run -d --name sshd -p 2222:22 `
  -e USER_NAME=dev -e USER_PASSWORD=dev `
  -e PASSWORD_ACCESS=true -e SUDO_ACCESS=true `
  lscr.io/linuxserver/openssh-server:latest
```

Trong app: Add server → host `localhost`, port `2222`, user `dev`, password `dev` → **Test connection** (pin fingerprint) → tạo project → mở tab → gõ lệnh trong terminal.

---

## Troubleshoot lỗi compile phổ biến

Repo được viết dựa trên **russh 0.46** và **tauri 2.1**. Nếu API các crate có drift:

- **`russh::keys::PrivateKeyWithHashAlg`**: nếu không tìm thấy, thử `russh::keys::key::PrivateKeyWithHashAlg`.
- **`PublicKey::to_bytes()`**: nếu lỗi, đổi sang `key.public_key_base64()` rồi base64-decode trước khi sha256.
- **`SftpSession::read_dir / metadata / open_with_flags`**: tên method có thể khác giữa các version `russh-sftp`; xem docs.rs/russh-sftp cho version đang dùng và sửa cho khớp.
- **`tauri_plugin_dialog` / `tauri_plugin_fs`**: đảm bảo version 2.0.x khớp với `tauri = 2.1.x`.

Thử nâng lock file:
```powershell
cd src-tauri
cargo update
```

Nếu vẫn lỗi, paste message vào chat, tôi sẽ vá từng chỗ.
