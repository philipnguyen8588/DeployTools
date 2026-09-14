//! Per-project sync manifest: local-relative path -> SHA-256 hex of the
//! file content at the last successful sync. Lets `deploy_sync` detect
//! content edits even when the byte size is unchanged, WITHOUT touching
//! remote metadata (so the upload path stays untouched — no 0-byte risk).
//!
//! Stored as JSON at `<vault-dir>/sync-state/<project_id>.json`.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::AppHandle;
use uuid::Uuid;

pub type Manifest = HashMap<String, String>;

fn manifest_path(app: &AppHandle, project_id: Uuid) -> PathBuf {
    let dir = crate::settings::resolve_vault_path(app)
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("sync-state");
    dir.join(format!("{project_id}.json"))
}

pub fn read(app: &AppHandle, project_id: Uuid) -> Manifest {
    match std::fs::read_to_string(manifest_path(app, project_id)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Manifest::new(),
    }
}

pub fn write(app: &AppHandle, project_id: Uuid, manifest: &Manifest) -> std::io::Result<()> {
    let path = manifest_path(app, project_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string(manifest).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(path, json)
}

/// Streaming SHA-256 of a file's contents, as lowercase hex. `None` on I/O
/// error (caller treats that as "changed" and uploads).
pub fn hash_file(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex::encode(hasher.finalize()))
}
