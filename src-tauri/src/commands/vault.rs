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
    state.vault.initialize(&master_password).await
}

#[tauri::command]
pub async fn vault_unlock(master_password: String, state: State<'_, AppState>) -> AppResult<()> {
    state.vault.unlock(&master_password).await
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> AppResult<()> {
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
