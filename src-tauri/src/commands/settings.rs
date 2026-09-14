//! Settings IPC — display + change the vault file location.
//!
//! Changing the vault location requires an app restart because the
//! `AppState` (which owns an `Arc<Vault>`) is built once at startup
//! from the resolved path. Restarting keeps the code simple and
//! avoids any risk of inconsistent state across open sessions.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::errors::{AppError, AppResult};
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
//
// Config lives in the encrypted vault, so these commands require the vault
// to be unlocked (the Settings UI is only reachable once it is).

#[derive(Serialize)]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub running: bool,
}

#[tauri::command]
pub async fn mcp_get_config(state: State<'_, AppState>) -> AppResult<McpConfig> {
    let token = crate::mcp::ensure_token(state.inner()).await?;
    let cfg = crate::mcp::read_cfg(state.inner()).await?;
    Ok(McpConfig {
        enabled: cfg.enabled,
        port: cfg.port,
        token,
        running: state.mcp_shutdown.lock().unwrap().is_some(),
    })
}

#[tauri::command]
pub async fn mcp_set_enabled(enabled: bool, state: State<'_, AppState>) -> AppResult<()> {
    state
        .vault
        .write(move |d| d.mcp_enabled = Some(enabled))
        .await?;
    if enabled {
        crate::mcp::start(state.inner()).await?;
    } else {
        crate::mcp::stop(state.inner());
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_regenerate_token(state: State<'_, AppState>) -> AppResult<String> {
    let bytes: [u8; 24] = rand::random();
    let token = hex::encode(bytes);
    let t2 = token.clone();
    state.vault.write(move |d| d.mcp_token = Some(t2)).await?;
    // Restart so the new token takes effect (spawn has bind-retry).
    crate::mcp::start(state.inner()).await?;
    Ok(token)
}

#[derive(Serialize)]
pub struct McpCommandPolicy {
    /// `off` | `deny` | `disabled`.
    pub mode: String,
    /// Effective denied program basenames.
    pub denylist: Vec<String>,
    /// Built-in defaults (for the "Reset to defaults" button).
    pub defaults: Vec<String>,
}

#[tauri::command]
pub async fn mcp_get_command_policy(state: State<'_, AppState>) -> AppResult<McpCommandPolicy> {
    let cfg = crate::mcp::read_cfg(state.inner()).await?;
    Ok(McpCommandPolicy {
        mode: cfg.cmd_mode,
        denylist: cfg.cmd_denylist,
        defaults: crate::mcp::policy::default_denied_programs(),
    })
}

#[tauri::command]
pub async fn mcp_set_command_policy(
    mode: String,
    denylist: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    if !matches!(mode.as_str(), "off" | "deny" | "disabled") {
        return Err(AppError::Other(format!("invalid mode: {mode}")));
    }
    let cleaned: Vec<String> = denylist
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    state
        .vault
        .write(move |d| {
            d.mcp_cmd_mode = Some(mode);
            d.mcp_cmd_denylist = Some(cleaned);
        })
        .await
}

// --- MCP activity audit log (stored in the vault) ---

#[tauri::command]
pub async fn mcp_activity_list(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::models::McpActivityEntry>> {
    let mut list = crate::logstore::read_activity(&state.app);
    list.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
    if let Some(l) = limit {
        list.truncate(l);
    }
    Ok(list)
}

#[tauri::command]
pub async fn mcp_activity_clear(state: State<'_, AppState>) -> AppResult<()> {
    crate::logstore::write_activity(&state.app, &[]).map_err(|e| crate::errors::AppError::Io(e.to_string()))
}
