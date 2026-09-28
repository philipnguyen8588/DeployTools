//! Shared capped-read plumbing for the file preview + compare features.
//! Both read a whole file into memory, so every reader enforces the same
//! size cap and binary sniff before any text reaches the frontend.

use serde::Serialize;

/// Hard ceiling for in-memory text reads (preview + compare). Files over
/// this are reported as `truncated` and never read at all.
pub const MAX_TEXT_BYTES: u64 = 1024 * 1024; // 1 MiB

/// Result of a capped read from any backend (local FS, SFTP, FTP).
/// `bytes` is `None` when the file exceeded the cap (nothing was read).
pub struct CappedRead {
    pub bytes: Option<Vec<u8>>,
    pub size: u64,
    pub mtime: Option<u64>,
}

/// Wire type for the read-only file preview.
#[derive(Serialize, Clone)]
pub struct TextFileContent {
    /// `None` when the file is binary, too large, or not valid UTF-8.
    pub text: Option<String>,
    /// Size exceeded MAX_TEXT_BYTES — nothing was read.
    pub truncated: bool,
    /// NUL byte found in the first 8 KiB.
    pub binary: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

/// NUL-byte sniff over the first 8 KiB — big enough to catch most
/// binaries, small enough to stay fast on large text files.
pub fn contains_nul(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// Classify a capped read into the preview wire type. The text is NOT
/// newline-normalized — the preview shows exactly what's stored.
pub fn classify(read: CappedRead) -> TextFileContent {
    match read.bytes {
        None => TextFileContent {
            text: None,
            truncated: true,
            binary: false,
            size: read.size,
            mtime: read.mtime,
        },
        Some(bytes) => {
            let binary = contains_nul(&bytes);
            let text = if binary {
                None
            } else {
                String::from_utf8(bytes).ok()
            };
            TextFileContent {
                // Not UTF-8 → treat like binary so the UI shows a fallback
                // instead of mojibake.
                binary: binary || text.is_none(),
                text,
                truncated: false,
                size: read.size,
                mtime: read.mtime,
            }
        }
    }
}
