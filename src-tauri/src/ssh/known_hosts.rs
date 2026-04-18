//! Host-key fingerprint helpers.
//!
//! We store the SHA-256 fingerprint of the server's host key on the
//! `Server` record after the first successful connection. On subsequent
//! connections we compare and refuse to proceed if they differ.

use base64::Engine;
use sha2::{Digest, Sha256};

/// OpenSSH-style SHA256 fingerprint: `SHA256:<unpadded-base64>`.
/// Matches `ssh-keygen -lf key -E sha256`.
pub fn fingerprint_sha256(public_key_wire_bytes: &[u8]) -> String {
    let digest = Sha256::digest(public_key_wire_bytes);
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest);
    format!("SHA256:{b64}")
}
