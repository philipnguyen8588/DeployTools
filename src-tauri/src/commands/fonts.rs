//! User-imported terminal fonts.
//!
//! Font files the user picks (e.g. Apple's SF Mono faces they already
//! own) are COPIED into `<vault dir>/fonts/` — the same folder the user
//! already backs up for `vault.enc`, and the app itself never bundles
//! them, so no font-license issue ships with the binary. The frontend
//! reads them back as base64 and registers them via the FontFace API.

use std::path::PathBuf;

use base64::Engine;
use serde::Serialize;

use crate::errors::{AppError, AppResult};

const ALLOWED_EXTS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];
/// Font files are small (100-500 KB); refuse anything absurd so a
/// mis-picked file can't balloon the backup folder.
const MAX_FONT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize, Clone)]
pub struct FontEntry {
    /// File name inside the fonts dir, e.g. "SFMono-Regular.otf".
    pub file_name: String,
    pub size: u64,
}

/// `<vault dir>/fonts` — created on demand.
fn fonts_dir(app: &tauri::AppHandle) -> PathBuf {
    let vault = crate::settings::resolve_vault_path(app);
    vault
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(crate::settings::exe_dir)
        .join("fonts")
}

/// Reject names that could escape the fonts dir ("..", separators).
fn validate_file_name(name: &str) -> AppResult<()> {
    if name.is_empty()
        || name.contains(['/', '\\'])
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err(AppError::InvalidPath(format!("bad font file name: {name}")));
    }
    Ok(())
}

fn has_allowed_ext(name: &str) -> bool {
    name.rsplit('.')
        .next()
        .map(|e| ALLOWED_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn font_list(app: tauri::AppHandle) -> AppResult<Vec<FontEntry>> {
    let dir = fonts_dir(&app);
    let mut out = Vec::new();
    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
        return Ok(out); // dir doesn't exist yet — no fonts imported
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !has_allowed_ext(&name) {
            continue;
        }
        let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
        out.push(FontEntry { file_name: name, size });
    }
    out.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(out)
}

/// Copy a user-picked font file into the fonts dir and return its entry.
#[tauri::command]
pub async fn font_import(path: PathBuf, app: tauri::AppHandle) -> AppResult<FontEntry> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| AppError::InvalidPath("no file name".into()))?;
    validate_file_name(&file_name)?;
    if !has_allowed_ext(&file_name) {
        return Err(AppError::InvalidPath(
            "unsupported font type — use .ttf, .otf, .woff or .woff2".into(),
        ));
    }
    let md = tokio::fs::metadata(&path).await?;
    if md.len() > MAX_FONT_BYTES {
        return Err(AppError::Other("font file too large".into()));
    }

    let dir = fonts_dir(&app);
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(&file_name);
    tokio::fs::copy(&path, &dest).await?;
    tracing::info!(target: "fonts", "imported {} -> {}", path.display(), dest.display());
    Ok(FontEntry {
        file_name,
        size: md.len(),
    })
}

/// Download a catalog font face into the fonts dir. Locked to the
/// Fontsource CDN — this is driven by the app's built-in free-font
/// catalog, never arbitrary user URLs.
#[tauri::command]
pub async fn font_download(
    url: String,
    file_name: String,
    app: tauri::AppHandle,
) -> AppResult<FontEntry> {
    validate_file_name(&file_name)?;
    if !has_allowed_ext(&file_name) {
        return Err(AppError::InvalidPath(
            "unsupported font type — use .ttf, .otf, .woff or .woff2".into(),
        ));
    }
    if !url.starts_with("https://cdn.jsdelivr.net/") {
        return Err(AppError::Other(
            "font downloads are restricted to cdn.jsdelivr.net".into(),
        ));
    }
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| AppError::Other(format!("download: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "download failed: HTTP {} for {url}",
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Other(format!("download body: {e}")))?;
    if bytes.len() as u64 > MAX_FONT_BYTES {
        return Err(AppError::Other("font file too large".into()));
    }
    let dir = fonts_dir(&app);
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(&file_name);
    tokio::fs::write(&dest, &bytes).await?;
    tracing::info!(target: "fonts", "downloaded {url} -> {}", dest.display());
    Ok(FontEntry {
        file_name,
        size: bytes.len() as u64,
    })
}

#[tauri::command]
pub async fn font_remove(file_name: String, app: tauri::AppHandle) -> AppResult<()> {
    validate_file_name(&file_name)?;
    let dest = fonts_dir(&app).join(&file_name);
    tokio::fs::remove_file(&dest).await?;
    Ok(())
}

/// Font bytes as base64 — the frontend turns this into a FontFace.
/// (base64 over the JSON IPC beats a Vec<u8> number-array by ~5x.)
#[tauri::command]
pub async fn font_read(file_name: String, app: tauri::AppHandle) -> AppResult<String> {
    validate_file_name(&file_name)?;
    let path = fonts_dir(&app).join(&file_name);
    let bytes = tokio::fs::read(&path).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
