//! Vault IPC commands — init / unlock / lock / change password.

use serde::Serialize;
use tauri::State;

use crate::errors::AppResult;
use crate::state::AppState;

#[derive(Serialize)]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> AppResult<VaultStatus> {
    Ok(VaultStatus {
        exists: state.vault.exists().await,
        unlocked: state.vault.is_unlocked().await,
    })
}

#[tauri::command]
pub async fn vault_init(master_password: String, state: State<'_, AppState>) -> AppResult<()> {
    state.vault.initialize(&master_password).await?;
    migrate_logs(state.inner()).await;
    // Vault is unlocked after init — bring up the MCP server (best-effort).
    let _ = crate::mcp::start(state.inner()).await;
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(master_password: String, state: State<'_, AppState>) -> AppResult<()> {
    state.vault.unlock(&master_password).await?;
    // One-time: move any history/activity that older builds kept inside the
    // vault out to the plaintext JSONL files.
    migrate_logs(state.inner()).await;
    // MCP config lives in the vault, so the server can only start now.
    let _ = crate::mcp::start(state.inner()).await;
    Ok(())
}

/// Move terminal history + MCP activity from the vault (older builds) into
/// the JSONL log files, then clear the vault copies. No-op once migrated.
async fn migrate_logs(state: &AppState) {
    let (hist, act) = match state
        .vault
        .read(|d| (d.terminal_history.clone(), d.mcp_activity.clone()))
        .await
    {
        Ok(v) => v,
        Err(_) => return,
    };
    if hist.is_empty() && act.is_empty() {
        return;
    }
    if !hist.is_empty() {
        let mut items = crate::logstore::read_history(&state.app);
        items.extend(hist);
        let _ = crate::logstore::write_history(&state.app, &items);
    }
    if !act.is_empty() {
        let mut items = crate::logstore::read_activity(&state.app);
        items.extend(act);
        let _ = crate::logstore::write_activity(&state.app, &items);
    }
    let _ = state
        .vault
        .write(|d| {
            d.terminal_history.clear();
            d.mcp_activity.clear();
        })
        .await;
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> AppResult<()> {
    // Stop the MCP server — its config/tools need the vault unlocked.
    crate::mcp::stop(state.inner());
    state.vault.lock().await;
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password(
    old_password: String,
    new_password: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .vault
        .change_password(&old_password, &new_password)
        .await
}
