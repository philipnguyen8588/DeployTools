//! Settings IPC — display + change the vault file location.
//!
//! Changing the vault location requires an app restart because the
//! `AppState` (which owns an `Arc<Vault>`) is built once at startup
//! from the resolved path. Restarting keeps the code simple and
//! avoids any risk of inconsistent state across open sessions.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::settings;
use crate::state::AppState;

#[derive(Serialize)]
pub struct SettingsView {
    /// Absolute path to `vault.enc` that the app is actually using.
    pub vault_path: PathBuf,
    /// Directory containing `vault.enc` (the user-visible folder).
    pub vault_dir: PathBuf,
    /// Whether the current directory matches the default (exe dir).
    pub is_default: bool,
    /// Default directory (exe dir) — shown as hint in the UI.
    pub default_dir: PathBuf,
    /// Directory of the running executable — always visible as reference.
    pub exe_dir: PathBuf,
    /// Whether the legacy `%APPDATA%\com.deploytools.app\vault.enc` still
    /// exists on disk. True if the user is on a previous install that
    /// used AppData; UI can prompt them to migrate.
    pub legacy_appdata_exists: bool,
    /// Absolute path of the legacy vault, if present.
    pub legacy_appdata_path: Option<PathBuf>,
    /// Idle timeout before auto-disconnect, in minutes. 0 = disabled.
    pub idle_timeout_minutes: u32,
    /// Default idle timeout (shown as hint).
    pub idle_timeout_default_minutes: u32,
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> SettingsView {
    let current = settings::resolve_vault_path(&app);
    let vault_dir = current
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(settings::default_vault_dir);
    let default_dir = settings::default_vault_dir();

    let (legacy_exists, legacy_path) = match app.path().app_data_dir() {
        Ok(p) => {
            let v = p.join("vault.enc");
            (v.exists(), Some(v))
        }
        Err(_) => (false, None),
    };

    SettingsView {
        is_default: vault_dir == default_dir,
        vault_path: current,
        vault_dir,
        default_dir,
        exe_dir: settings::exe_dir(),
        legacy_appdata_exists: legacy_exists,
        legacy_appdata_path: legacy_path,
        idle_timeout_minutes: settings::resolved_idle_timeout_minutes(),
        idle_timeout_default_minutes: settings::DEFAULT_IDLE_TIMEOUT_MINUTES,
    }
}

#[tauri::command]
pub fn set_idle_timeout_minutes(minutes: u32) -> Result<(), String> {
    // Cap at 24 h so a typo (say `300000`) doesn't disable the feature
    // for practical purposes without the user realising.
    let minutes = minutes.min(24 * 60);
    let mut s = settings::load();
    s.idle_timeout_minutes = Some(minutes);
    settings::save(&s).map_err(|e| format!("Save settings: {e}"))
}

#[tauri::command]
pub fn set_vault_dir(dir: String) -> Result<(), String> {
    let path = PathBuf::from(&dir);
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", dir));
    }
    let mut s = settings::load();
    s.vault_dir = Some(path);
    settings::save(&s).map_err(|e| format!("Save settings: {e}"))
}

#[tauri::command]
pub fn reset_vault_dir() -> Result<(), String> {
    let mut s = settings::load();
    s.vault_dir = None;
    settings::save(&s).map_err(|e| format!("Save settings: {e}"))
}

/// Hard restart the app process — used after changing the vault
/// location since `AppState` is immutable at runtime.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

// --- MCP server (lets AI agents drive the app) ---

#[derive(Serialize)]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub running: bool,
}

#[tauri::command]
pub fn mcp_get_config(state: State<'_, AppState>) -> McpConfig {
    McpConfig {
        enabled: settings::mcp_enabled(),
        port: settings::mcp_port(),
        token: settings::ensure_mcp_token(),
        running: state.mcp_shutdown.lock().unwrap().is_some(),
    }
}

#[tauri::command]
pub fn mcp_set_enabled(
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.mcp_enabled = Some(enabled);
    settings::save(&s).map_err(|e| format!("Save settings: {e}"))?;

    let mut guard = state.mcp_shutdown.lock().unwrap();
    if enabled {
        if guard.is_none() {
            let token = settings::ensure_mcp_token();
            let tx = crate::mcp::spawn(app.clone(), settings::mcp_port(), token);
            *guard = Some(tx);
        }
    } else if let Some(tx) = guard.take() {
        let _ = tx.send(true);
    }
    Ok(())
}

/// Generate a fresh token, persist it, and restart the server so the new
/// token takes effect. Async so we can let the old listener release the
/// port before rebinding.
#[tauri::command]
pub async fn mcp_regenerate_token(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let bytes: [u8; 24] = rand::random();
    let token = hex::encode(bytes);
    let mut s = settings::load();
    s.mcp_token = Some(token.clone());
    settings::save(&s).map_err(|e| format!("Save settings: {e}"))?;

    // Stop the running server (if any), releasing the lock before awaiting.
    let was_running = {
        let mut guard = state.mcp_shutdown.lock().unwrap();
        match guard.take() {
            Some(tx) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    };

    if was_running && settings::mcp_enabled() {
        // Give the old listener a moment to free the port before rebinding.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let tx = crate::mcp::spawn(app.clone(), settings::mcp_port(), token.clone());
        *state.mcp_shutdown.lock().unwrap() = Some(tx);
    }
    Ok(token)
}
