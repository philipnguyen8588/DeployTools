//! Tauri IPC command handlers. Each submodule corresponds to one area
//! of the UI. All commands return `AppResult<T>` so errors are conveyed
//! as plain strings to the frontend.

pub mod cloudflare;
pub mod deploy;
pub mod docker;
pub mod git;
pub mod history;
pub mod metrics;
pub mod project;
pub mod services;
pub mod snippets;
pub mod server;
pub mod session;
pub mod settings;
pub mod sftp;
pub mod shell;
pub mod terminal;
pub mod vault;
