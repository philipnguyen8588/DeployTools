//! Auto Deployment — Tauri backend entry point.
//!
//! This library wires the Rust modules into Tauri command handlers,
//! sets up logging, initializes the vault state, the SSH session pool,
//! and registers all IPC commands used by the React frontend.

pub mod cloudflare;
pub mod commands;
pub mod compose;
pub mod errors;
pub mod ftp;
pub mod models;
pub mod rsync;
pub mod settings;
pub mod ssh;
pub mod state;
pub mod vault;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

/// Runs the Tauri application. Called from `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging — default to INFO, respect RUST_LOG.
    // We never log credentials; see `vault::crypto` and `ssh::client` for redaction.
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,deploy_tools_lib=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Remembers window size / position / maximize state between
        // launches. No config needed — sensible defaults cover every
        // window the app creates.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let state = AppState::new(app.handle().clone());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Vault
            commands::vault::vault_status,
            commands::vault::vault_init,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_change_password,
            // Servers (SSH profiles)
            commands::server::list_servers,
            commands::server::get_server,
            commands::server::save_server,
            commands::server::delete_server,
            commands::server::test_connection,
            commands::server::test_connection_config,
            commands::server::reorder_servers,
            // Server groups (sidebar organisation)
            commands::groups::list_groups,
            commands::groups::save_group,
            commands::groups::delete_group,
            commands::groups::reorder_groups,
            // Projects (local ↔ remote mapping)
            commands::project::list_projects,
            commands::project::save_project,
            commands::project::delete_project,
            commands::project::reorder_projects,
            // SSH sessions (multi-tab)
            commands::session::open_session,
            commands::session::close_session,
            commands::session::list_sessions,
            // Integrated terminal
            commands::terminal::term_open,
            commands::terminal::term_write,
            commands::terminal::term_resize,
            commands::terminal::term_close,
            // SFTP remote file browser
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rm,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_download,
            // Deploy
            commands::deploy::deploy_file,
            commands::deploy::deploy_folder,
            commands::deploy::deploy_rsync,
            commands::deploy::deploy_sync,
            commands::deploy::list_local_tree,
            commands::deploy::compare_file,
            commands::deploy::compare_folder,
            // Git
            commands::git::git_info,
            commands::git::git_status,
            commands::git::git_log,
            commands::git::git_files_in_commit,
            // Terminal history (per-server, stored in vault)
            commands::history::history_list,
            commands::history::history_add,
            commands::history::history_clear,
            // Snippets
            commands::snippets::snippet_list,
            commands::snippets::snippet_save,
            commands::snippets::snippet_delete,
            commands::snippets::snippet_run,
            commands::snippets::snippet_resolve,
            // Services (systemd)
            commands::services::service_list,
            commands::services::service_action,
            // Metrics
            commands::metrics::fetch_metrics,
            // Docker Compose
            commands::docker::docker_compose_info,
            commands::docker::docker_compose_ps,
            commands::docker::docker_compose_action,
            commands::docker::docker_compose_logs_follow,
            commands::docker::docker_compose_logs_stop,
            commands::docker::docker_compose_exec_shell,
            commands::docker::session_capabilities,
            // System terminal (local shell or SSH in a native window)
            commands::shell::open_local_terminal,
            commands::shell::open_ssh_terminal,
            // IDE launcher (VSCode / PyCharm / IntelliJ / Antigravity + custom)
            commands::ide::list_ides,
            commands::ide::set_ide_path,
            commands::ide::clear_ide_path,
            commands::ide::add_custom_ide,
            commands::ide::autopopulate_ide_paths,
            commands::ide::open_ide,
            // Settings (vault location + portable mode)
            commands::settings::get_settings,
            commands::settings::set_vault_dir,
            commands::settings::reset_vault_dir,
            commands::settings::set_idle_timeout_minutes,
            commands::settings::restart_app,
            // Cloudflare
            commands::cloudflare::cf_has_token,
            commands::cloudflare::cf_set_token,
            commands::cloudflare::cf_clear_token,
            commands::cloudflare::cf_verify,
            commands::cloudflare::cf_list_zones,
            commands::cloudflare::cf_list_records,
            commands::cloudflare::cf_update_record,
            commands::cloudflare::cf_create_record,
            commands::cloudflare::cf_delete_record,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
