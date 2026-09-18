//! Low-level SSH client wrapper around `russh` 0.46.
//!
//! Responsibilities:
//! - Connect + authenticate (password / private key)
//! - Capture the server's host-key fingerprint
//! - Enforce host-key pinning when a fingerprint is already on file
//! - Produce a `russh::client::Handle` that the session pool can use
//!   to open channels (shell, SFTP, exec).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Handle, Handler};
use russh::keys::decode_secret_key;
use tokio::sync::Mutex;

use crate::errors::{AppError, AppResult};
use crate::models::{AuthMethod, JumpHost, Secret, Server};

/// Result of a connection attempt — includes the live handle and the
/// fingerprint we observed on the server.
pub struct SshClient {
    pub handle: Handle<ClientHandler>,
    pub fingerprint: String,
    /// When the target is reached through a jump host, this holds the live
    /// jump-host client. The target's transport is a `direct-tcpip`
    /// channel opened on `jump.handle`, so the jump connection must stay
    /// alive for the whole session — dropping it tears down the tunnel.
    pub jump: Option<Box<SshClient>>,
}

/// Handler implements the policy for the SSH session. We accept any
/// server key at the transport layer and let the caller decide whether
/// to trust it based on the pinned fingerprint stored in `Server`.
pub struct ClientHandler {
    /// Captured from `check_server_key` and read after handshake.
    pub captured_fp: Arc<Mutex<Option<String>>>,
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // russh-keys gives us the SHA256 fingerprint directly (base64, no padding).
        // Format to match the OpenSSH convention `SHA256:<b64>`.
        let fp = format!("SHA256:{}", server_public_key.fingerprint());
        *self.captured_fp.lock().await = Some(fp);
        // Accept the key at the transport level. TOFU on first connect;
        // subsequent connects compare the fingerprint against the pinned one.
        Ok(true)
    }
}

fn make_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    })
}

/// Pin the captured host key against `expected_fp` (if any), then
/// authenticate `handle` as `user` with `auth`. Returns the observed
/// fingerprint. `ctx` prefixes error messages ("server" / "jump host").
async fn pin_and_auth(
    handle: &mut Handle<ClientHandler>,
    captured: &Arc<Mutex<Option<String>>>,
    user: &str,
    auth: &AuthMethod,
    expected_fp: Option<&String>,
    ctx: &str,
) -> AppResult<String> {
    let observed = captured
        .lock()
        .await
        .clone()
        .ok_or_else(|| AppError::Ssh(format!("{ctx}: no host key captured")))?;
    if let Some(expected) = expected_fp {
        if expected != &observed {
            return Err(AppError::HostKeyMismatch {
                expected: expected.clone(),
                actual: observed,
            });
        }
    }

    let auth_ok = match auth {
        AuthMethod::Password { password } => handle
            .authenticate_password(user, password.expose())
            .await
            .map_err(|e| AppError::Ssh(format!("{ctx} auth: {e}")))?,
        AuthMethod::PrivateKey { key_path, passphrase } => {
            // Accept either an inline PEM block (starts with "-----BEGIN")
            // or a path to a key file.
            let pem = if key_path.trim_start().starts_with("-----BEGIN") {
                key_path.clone()
            } else {
                tokio::fs::read_to_string(key_path).await?
            };
            let keypair = decode_secret_key(
                &pem,
                passphrase.as_ref().map(Secret::expose).filter(|s| !s.is_empty()),
            )
            .map_err(|e| AppError::Ssh(format!("{ctx} decode key: {e}")))?;
            handle
                .authenticate_publickey(user, Arc::new(keypair))
                .await
                .map_err(|e| AppError::Ssh(format!("{ctx} auth: {e}")))?
        }
    };
    if !auth_ok {
        return Err(AppError::Ssh(format!("{ctx}: authentication failed")));
    }
    Ok(observed)
}

/// Open a plain TCP SSH connection to `host:port` and authenticate.
async fn connect_direct(
    host: &str,
    port: u16,
    user: &str,
    auth: &AuthMethod,
    expected_fp: Option<&String>,
    ctx: &str,
) -> AppResult<(Handle<ClientHandler>, String)> {
    let handler = ClientHandler {
        captured_fp: Arc::new(Mutex::new(None)),
    };
    let captured = handler.captured_fp.clone();
    let mut handle = client::connect(make_config(), (host, port), handler)
        .await
        .map_err(|e| AppError::Ssh(format!("{ctx} connect: {e}")))?;
    let fp = pin_and_auth(&mut handle, &captured, user, auth, expected_fp, ctx).await?;
    Ok((handle, fp))
}

/// Connect to `server` and authenticate. If `server.jump_host` is set, the
/// connection is tunneled through that bastion (OpenSSH ProxyJump). If
/// `host_key_fingerprint` is set (on the server and/or jump host), the
/// observed fingerprint must match; otherwise `HostKeyMismatch`.
pub async fn connect(server: &Server) -> AppResult<SshClient> {
    let Some(jump) = &server.jump_host else {
        // Direct connection (unchanged behavior).
        let (handle, fingerprint) = connect_direct(
            &server.host,
            server.port,
            &server.user,
            &server.auth,
            server.host_key_fingerprint.as_ref(),
            "server",
        )
        .await?;
        return Ok(SshClient { handle, fingerprint, jump: None });
    };

    connect_via_jump(server, jump).await
}

/// Connect to `server` through the given `jump` bastion.
async fn connect_via_jump(server: &Server, jump: &JumpHost) -> AppResult<SshClient> {
    // 1. Connect + authenticate to the jump host itself.
    let (jump_handle, jump_fp) = connect_direct(
        &jump.host,
        jump.port,
        &jump.user,
        &jump.auth,
        jump.host_key_fingerprint.as_ref(),
        "jump host",
    )
    .await?;
    let jump_client = SshClient {
        handle: jump_handle,
        fingerprint: jump_fp,
        jump: None,
    };

    // 2. Open a direct-tcpip channel on the jump host to the real target,
    //    and use it as the transport stream for the target's SSH session.
    let channel = jump_client
        .handle
        .channel_open_direct_tcpip(server.host.clone(), server.port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| {
            AppError::Ssh(format!(
                "jump tunnel to {}:{}: {e}",
                server.host, server.port
            ))
        })?;

    // 3. SSH handshake to the target over the tunnel, then pin + auth.
    let handler = ClientHandler {
        captured_fp: Arc::new(Mutex::new(None)),
    };
    let captured = handler.captured_fp.clone();
    let mut handle = client::connect_stream(make_config(), channel.into_stream(), handler)
        .await
        .map_err(|e| AppError::Ssh(format!("server connect (via jump): {e}")))?;
    let fingerprint = pin_and_auth(
        &mut handle,
        &captured,
        &server.user,
        &server.auth,
        server.host_key_fingerprint.as_ref(),
        "server",
    )
    .await?;

    Ok(SshClient {
        handle,
        fingerprint,
        jump: Some(Box::new(jump_client)),
    })
}

/// Scrub any credential fragments out of a log line before emitting it.
pub fn redact(line: &str) -> String {
    // Defense in depth — we never pass secrets into user-visible logs,
    // but filter anything that looks like one just in case.
    let mut out = line.to_string();
    for pat in ["PRIVATE KEY", "BEGIN OPENSSH", "password="] {
        if let Some(i) = out.find(pat) {
            out.truncate(i);
            out.push_str("<redacted>");
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_strips_private_key() {
        let line = "error: -----BEGIN OPENSSH PRIVATE KEY-----\nAAAA";
        let r = redact(line);
        assert!(!r.contains("AAAA"));
        assert!(r.contains("redacted"));
    }
}
