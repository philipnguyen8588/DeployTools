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
pub mod logstore;
pub mod mcp;
pub mod models;
pub mod rsync;
pub mod settings;
pub mod syncstate;
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
        // launches. We deliberately drop the DECORATIONS flag: the app
        // always uses custom chrome (`decorations: false`), and the
        // plugin's default restores *all* state — so a stale
        // decorations=true persisted by an earlier build would bring the
        // native macOS title bar back, overriding the config.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .setup(|app| {
            let state = AppState::new(app.handle().clone());
            app.manage(state);
            // The MCP server starts on vault unlock (its config lives in the
            // vault) — see commands::vault::vault_unlock.

            // Belt-and-suspenders: force the native title bar off after the
            // window-state plugin has restored. Guarantees no native macOS
            // chrome even if a stale decorations=true was saved previously.
            // Also round the window corners in the current macOS style.
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    apply_macos_rounded_corners(&window);
                }
            }

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
            commands::deploy::deploy_smart_sync,
            commands::deploy::download_to_mapped,
            commands::deploy::download_to,
            commands::deploy::cancel_deploy,
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
            commands::shell::reveal_path,
            // SSH local-forward tunnels
            commands::tunnel::start_tunnel,
            commands::tunnel::stop_tunnel,
            commands::tunnel::list_tunnels,
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
            commands::settings::mcp_get_config,
            commands::settings::mcp_set_enabled,
            commands::settings::mcp_regenerate_token,
            commands::settings::mcp_get_command_policy,
            commands::settings::mcp_set_command_policy,
            commands::settings::mcp_activity_list,
            commands::settings::mcp_activity_clear,
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

/// Give the frameless macOS window rounded corners in the current macOS
/// style, using only public AppKit APIs (App Store safe — no private API,
/// no `transparent: true`).
///
/// We make the `NSWindow` non-opaque with a clear background so the four
/// corners can show the desktop, then clip the content view's layer to a
/// rounded rectangle. `masksToBounds` makes the WKWebView subview follow
/// the same rounded shape. This avoids the over-rounded look that macOS 26
/// (Tahoe) applies to Tauri's private-API transparent windows.
#[cfg(target_os = "macos")]
fn apply_macos_rounded_corners(window: &tauri::WebviewWindow) {
    use cocoa::base::{id, nil, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};

    // Content corner radius in points. Kept modest so it reads as a
    // native window, not the exaggerated Tahoe toolbar radius.
    const RADIUS: f64 = 10.0;

    let ns_window = match window.ns_window() {
        Ok(w) => w as id,
        Err(_) => return,
    };

    unsafe {
        // Transparent window background via PUBLIC API so the corners
        // outside the rounded content are see-through.
        let _: () = msg_send![ns_window, setOpaque: NO];
        let clear: id = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns_window, setBackgroundColor: clear];
        let _: () = msg_send![ns_window, setHasShadow: YES];

        // Clip the content view (and its WKWebView subview) to a rounded
        // rectangle.
        let content: id = msg_send![ns_window, contentView];
        if content != nil {
            let _: () = msg_send![content, setWantsLayer: YES];
            let layer: id = msg_send![content, layer];
            if layer != nil {
                let _: () = msg_send![layer, setCornerRadius: RADIUS];
                let _: () = msg_send![layer, setMasksToBounds: YES];
            }
        }
    }
}
