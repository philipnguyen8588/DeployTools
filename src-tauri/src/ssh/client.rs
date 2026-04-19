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
use crate::models::{AuthMethod, Secret, Server};

/// Result of a connection attempt — includes the live handle and the
/// fingerprint we observed on the server.
pub struct SshClient {
    pub handle: Handle<ClientHandler>,
    pub fingerprint: String,
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

/// Connect to `server` and authenticate. If `server.host_key_fingerprint`
/// is set, the observed fingerprint must match; otherwise `HostKeyMismatch`
/// is returned.
pub async fn connect(server: &Server) -> AppResult<SshClient> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let handler = ClientHandler {
        captured_fp: Arc::new(Mutex::new(None)),
    };
    let captured = handler.captured_fp.clone();

    let addr = (server.host.as_str(), server.port);
    let mut handle = client::connect(config, addr, handler)
        .await
        .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;

    // --- Host-key pinning check ---
    let observed = captured
        .lock()
        .await
        .clone()
        .ok_or_else(|| AppError::Ssh("no host key captured".into()))?;
    if let Some(expected) = &server.host_key_fingerprint {
        if expected != &observed {
            return Err(AppError::HostKeyMismatch {
                expected: expected.clone(),
                actual: observed,
            });
        }
    }

    // --- Authenticate ---
    let auth_ok = match &server.auth {
        AuthMethod::Password { password } => handle
            .authenticate_password(&server.user, password.expose())
            .await
            .map_err(|e| AppError::Ssh(format!("auth: {e}")))?,
        AuthMethod::PrivateKey { key_path, passphrase } => {
            // Accept either an inline PEM block (starts with "-----BEGIN")
            // or a path to a key file. Pasting the key directly avoids
            // making the user save a temporary file just to connect.
            let pem = if key_path.trim_start().starts_with("-----BEGIN") {
                key_path.clone()
            } else {
                tokio::fs::read_to_string(key_path).await?
            };
            let keypair = decode_secret_key(
                &pem,
                passphrase.as_ref().map(Secret::expose).filter(|s| !s.is_empty()),
            )
            .map_err(|e| AppError::Ssh(format!("decode key: {e}")))?;
            handle
                .authenticate_publickey(&server.user, Arc::new(keypair))
                .await
                .map_err(|e| AppError::Ssh(format!("auth: {e}")))?
        }
    };

    if !auth_ok {
        return Err(AppError::Ssh("authentication failed".into()));
    }

    Ok(SshClient {
        handle,
        fingerprint: observed,
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
