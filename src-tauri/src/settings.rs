//! Persistent app settings, stored as `settings.json` **next to the
//! running executable**.
//!
//! Keeping settings beside the exe (not in `%APPDATA%`) makes the app
//! portable: the user can move the whole install folder to a USB stick
//! / Dropbox / another PC and the vault location follows. `vault.enc`
//! by default also lives next to the exe.
//!
//! Path resolution for the vault file:
//!   1. `settings.vault_dir` (user override) → `<that>/vault.enc`
//!   2. `<exe-dir>/vault.enc` if it exists (new install happy path)
//!   3. Legacy `%APPDATA%\com.deploytools.app\vault.enc` if still there
//!      (so existing users don't lose data after upgrade)
//!   4. Otherwise default to `<exe-dir>/vault.enc` — first run creates it

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Settings {
    /// Directory that holds `vault.enc`. `None` means "use the exe dir
    /// (default)".
    pub vault_dir: Option<PathBuf>,

    /// Minutes of terminal inactivity before the app proactively closes
    /// the SSH session. `None` = use default (30 min). `Some(0)` =
    /// disabled, never auto-disconnect.
    #[serde(default)]
    pub idle_timeout_minutes: Option<u32>,

    /// IDE key → absolute path to its exe. Populated from the Settings
    /// dialog or from `ide::detect_ides` on first install.
    /// Built-in keys: "vscode", "pycharm", "intellij", "antigravity".
    /// Custom entries use any other key; their display label is stored
    /// in `custom_ide_labels` (built-ins use a hardcoded label).
    #[serde(default)]
    pub ide_paths: HashMap<String, String>,

    /// Display label for user-added custom IDEs. Keys here must also
    /// appear in `ide_paths`. Built-in keys are NOT stored here.
    #[serde(default)]
    pub custom_ide_labels: HashMap<String, String>,

    /// Whether the embedded MCP server (lets AI agents drive the app) is
    /// enabled. `None` = default (enabled).
    #[serde(default)]
    pub mcp_enabled: Option<bool>,

    /// TCP port the MCP server binds on 127.0.0.1. `None` = default.
    #[serde(default)]
    pub mcp_port: Option<u16>,

    /// Bearer token required on every MCP request. Generated on first run.
    #[serde(default)]
    pub mcp_token: Option<String>,

    /// Command guard mode for the MCP `run_command` tool:
    /// `off` (allow all) | `deny` (block dangerous — default) | `disabled`.
    #[serde(default)]
    pub mcp_cmd_mode: Option<String>,

    /// Denied program basenames for the `deny` guard mode. `None` = use the
    /// built-in defaults (`crate::mcp::policy::default_denied_programs`).
    #[serde(default)]
    pub mcp_cmd_denylist: Option<Vec<String>>,
}

/// Default MCP server port (bound on 127.0.0.1 only).
pub const DEFAULT_MCP_PORT: u16 = 8765;

pub fn mcp_enabled() -> bool {
    load().mcp_enabled.unwrap_or(true)
}

pub fn mcp_port() -> u16 {
    load().mcp_port.unwrap_or(DEFAULT_MCP_PORT)
}

/// Command guard mode for the MCP terminal tool.
pub fn mcp_cmd_mode() -> String {
    load()
        .mcp_cmd_mode
        .filter(|m| matches!(m.as_str(), "off" | "deny" | "disabled"))
        .unwrap_or_else(|| "deny".to_string())
}

/// Effective denied-program list — user override or built-in defaults.
pub fn mcp_denied_programs() -> Vec<String> {
    load()
        .mcp_cmd_denylist
        .unwrap_or_else(crate::mcp::policy::default_denied_programs)
}

/// Return the persisted MCP token, generating + saving one if absent.
pub fn ensure_mcp_token() -> String {
    let mut s = load();
    if let Some(t) = &s.mcp_token {
        if !t.is_empty() {
            return t.clone();
        }
    }
    let bytes: [u8; 24] = rand::random();
    let token = hex::encode(bytes);
    s.mcp_token = Some(token.clone());
    let _ = save(&s);
    token
}

/// Built-in default when the user hasn't configured anything.
pub const DEFAULT_IDLE_TIMEOUT_MINUTES: u32 = 30;

pub fn resolved_idle_timeout_minutes() -> u32 {
    load().idle_timeout_minutes.unwrap_or(DEFAULT_IDLE_TIMEOUT_MINUTES)
}

/// Absolute path of the directory containing the running exe. Falls
/// back to the current working directory if the exe path cannot be
/// resolved (e.g. in some dev/test contexts).
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Default directory where the vault should live when no override is
/// configured — the exe directory.
pub fn default_vault_dir() -> PathBuf {
    exe_dir()
}

/// Path of the `settings.json` file. Always next to the exe.
fn settings_file_path() -> PathBuf {
    exe_dir().join("settings.json")
}

pub fn load() -> Settings {
    let path = settings_file_path();
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(s: &Settings) -> std::io::Result<()> {
    let path = settings_file_path();
    let json = serde_json::to_string_pretty(s).unwrap();
    fs::write(path, json)
}

/// Resolve the concrete `vault.enc` path the app should read/write at
/// this moment. Priority:
///   1. `settings.vault_dir` override
///   2. Exe-dir default (if that file already exists)
///   3. Legacy `%APPDATA%` location (if it still has a vault) — old users
///   4. Exe-dir default (even if file doesn't exist yet — first run)
pub fn resolve_vault_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;

    let settings = load();
    if let Some(dir) = settings.vault_dir {
        return dir.join("vault.enc");
    }

    let default = default_vault_dir().join("vault.enc");
    if default.exists() {
        return default;
    }

    // Legacy — data from the old AppData-based install. Only use it if
    // the new location is still empty so we don't confuse a fresh
    // install on a machine that happens to have had an older version.
    if let Ok(data_dir) = app.path().app_data_dir() {
        let legacy = data_dir.join("vault.enc");
        if legacy.exists() {
            tracing::info!(
                target: "settings",
                "using legacy vault at {} (default is {})",
                legacy.display(),
                default.display(),
            );
            return legacy;
        }
    }

    default
}
