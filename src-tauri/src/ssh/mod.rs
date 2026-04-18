//! SSH / SFTP / terminal subsystem built on top of `russh`.
//!
//! - `client`       — low-level SSH handshake + auth + host-key policy
//! - `session_pool` — many-sessions-per-app handle registry (1 tab = 1 session)
//! - `terminal`     — PTY + shell channel, streams bytes to/from xterm.js
//! - `sftp`         — SFTP wrapper for the remote file browser
//! - `known_hosts`  — fingerprint helpers

pub mod activity;
pub mod capabilities;
pub mod client;
pub mod exec;
pub mod known_hosts;
pub mod quote;
pub mod session_pool;
pub mod sftp;
pub mod terminal;

pub use client::{ClientHandler, SshClient};
pub use session_pool::{SessionId, SessionPool, SshSession};
