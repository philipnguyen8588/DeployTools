//! Locally-installed IDE launcher.
//!
//! Responsibilities:
//!   * Detect common IDE installs on the machine — so the user does not
//!     have to hunt down each exe path manually on first run.
//!   * Persist user overrides in `settings.json` (beside the exe).
//!   * Spawn an IDE with a project folder argument.
//!
//! Supported keys (stable — referenced from the frontend):
//!   "vscode"       → Visual Studio Code (Code.exe)
//!   "pycharm"      → JetBrains PyCharm (pycharm64.exe)
//!   "intellij"     → JetBrains IntelliJ IDEA (idea64.exe)
//!   "antigravity"  → Google Antigravity (antigravity.exe)
//!
//! Detection is cross-platform: Windows (Program Files / LocalAppData /
//! JetBrains Toolbox), macOS (`/Applications` + `~/Applications` app
//! bundles + Toolbox under Application Support) and a best-effort set of
//! common Linux paths. The user can always override any path in Settings.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::errors::{AppError, AppResult};
use crate::settings;

/// View returned to the frontend: keyed by IDE key, value contains the
/// currently-configured path (from settings) AND the auto-detected
/// path (from the filesystem scan). The UI surfaces both so the user
/// can accept the detected default or override it.
#[derive(Serialize, Clone, Debug)]
pub struct IdeEntry {
    pub key: String,
    pub label: String,
    /// Path from `settings.json`. `None` when the user hasn't pinned one.
    pub configured: Option<String>,
    /// Path found by scanning the filesystem. `None` if nothing plausible.
    pub detected: Option<String>,
    /// True for the hardcoded built-in set (VSCode / PyCharm / …). False
    /// for user-added custom entries — those can be renamed or removed
    /// completely from Settings.
    pub is_builtin: bool,
}

const BUILTIN_KEYS: &[&str] = &["vscode", "pycharm", "antigravity", "intellij"];

fn is_builtin_key(key: &str) -> bool {
    BUILTIN_KEYS.contains(&key)
}

/// Labels for the UI. Kept in Rust so both detect + launch agree.
fn ide_label(key: &str) -> &'static str {
    match key {
        "vscode" => "Visual Studio Code",
        "pycharm" => "PyCharm",
        "intellij" => "IntelliJ IDEA",
        "antigravity" => "Antigravity",
        _ => "Unknown IDE",
    }
}

/// Return the list of IDEs, each with detected + configured paths.
/// Order: the four built-ins (fixed order so the menu stays predictable)
/// followed by any user-added customs sorted alphabetically by label.
#[tauri::command]
pub fn list_ides() -> Vec<IdeEntry> {
    let s = settings::load();

    let mut out: Vec<IdeEntry> = BUILTIN_KEYS
        .iter()
        .map(|k| IdeEntry {
            key: (*k).to_string(),
            label: ide_label(k).to_string(),
            configured: s.ide_paths.get(*k).cloned(),
            detected: detect_one(k),
            is_builtin: true,
        })
        .collect();

    let mut customs: Vec<IdeEntry> = s
        .custom_ide_labels
        .iter()
        .map(|(k, label)| IdeEntry {
            key: k.clone(),
            label: label.clone(),
            configured: s.ide_paths.get(k).cloned(),
            detected: None,
            is_builtin: false,
        })
        .collect();
    customs.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    out.extend(customs);
    out
}

#[tauri::command]
pub fn set_ide_path(key: String, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }
    let mut s = settings::load();
    s.ide_paths.insert(key, path);
    settings::save(&s).map_err(|e| format!("Save settings: {e}"))
}

#[tauri::command]
pub fn clear_ide_path(key: String) -> Result<(), String> {
    let mut s = settings::load();
    s.ide_paths.remove(&key);
    // Built-in keys never go away — just losing the path is enough.
    // Custom entries also have a label stored; drop that too, which
    // effectively removes the IDE from the list.
    if !is_builtin_key(&key) {
        s.custom_ide_labels.remove(&key);
    }
    settings::save(&s).map_err(|e| format!("Save settings: {e}"))
}

/// Register a new user-defined IDE. Generates a stable key from the
/// label (slug), rejects collisions with built-ins.
#[tauri::command]
pub fn add_custom_ide(label: String, path: String) -> Result<String, String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("Label is required".into());
    }
    if !PathBuf::from(&path).is_file() {
        return Err(format!("Not a file: {}", path));
    }
    let key = slugify(&label);
    if key.is_empty() {
        return Err("Label produces an empty key".into());
    }
    if is_builtin_key(&key) {
        return Err(format!(
            "That name clashes with a built-in IDE ({}).",
            ide_label(&key)
        ));
    }
    let mut s = settings::load();
    // Collision handling: if the key exists (same label), just update
    // the path; otherwise insert fresh.
    s.custom_ide_labels.insert(key.clone(), label);
    s.ide_paths.insert(key.clone(), path);
    settings::save(&s).map_err(|e| format!("Save settings: {e}"))?;
    Ok(key)
}

fn slugify(label: &str) -> String {
    label
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else if c == ' ' || c == '_' {
                '-'
            } else {
                // strip unknown punctuation
                '\0'
            }
        })
        .filter(|c| *c != '\0')
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// First-run helper — for every IDE key that has a detected path but
/// no configured one yet, pin the detected value. Idempotent; the UI
/// calls it on app start so the user gets sensible defaults without
/// having to visit Settings.
#[tauri::command]
pub fn autopopulate_ide_paths() -> Result<Vec<String>, String> {
    let mut s = settings::load();
    let mut filled = Vec::new();
    for k in ["vscode", "pycharm", "intellij", "antigravity"] {
        if s.ide_paths.contains_key(k) {
            continue;
        }
        if let Some(p) = detect_one(k) {
            s.ide_paths.insert(k.into(), p);
            filled.push(k.into());
        }
    }
    if !filled.is_empty() {
        settings::save(&s).map_err(|e| format!("Save settings: {e}"))?;
    }
    Ok(filled)
}

/// Launch an IDE with `project_path` as the initial argument.
#[tauri::command]
pub fn open_ide(key: String, project_path: String) -> AppResult<()> {
    let s = settings::load();
    let exe = s
        .ide_paths
        .get(&key)
        .cloned()
        .or_else(|| detect_one(&key))
        .ok_or_else(|| {
            AppError::Other(format!(
                "{} is not configured — set its path in Settings.",
                ide_label(&key)
            ))
        })?;
    let exe_path = PathBuf::from(&exe);
    if !exe_path.is_file() {
        return Err(AppError::Other(format!(
            "Configured path for {} does not exist: {}",
            ide_label(&key),
            exe
        )));
    }
    Command::new(&exe_path)
        .arg(&project_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::Other(format!("spawn {}: {e}", ide_label(&key))))?;
    Ok(())
}

// ----- detection (cross-platform) -----

fn detect_one(key: &str) -> Option<String> {
    let candidates = candidate_paths(key);
    for c in candidates {
        if Path::new(&c).is_file() {
            return Some(c);
        }
    }
    // Final fallback: walk a JetBrains-specific Toolbox tree looking
    // for the first match. Limited to JetBrains IDEs; others aren't
    // installed via Toolbox.
    match key {
        "pycharm" | "intellij" => detect_jetbrains_toolbox(key),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn candidate_paths(key: &str) -> Vec<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| {
        "C:\\Program Files".into()
    });
    let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| {
        "C:\\Program Files (x86)".into()
    });

    match key {
        "vscode" => vec![
            format!("{local}\\Programs\\Microsoft VS Code\\Code.exe"),
            format!("{program_files}\\Microsoft VS Code\\Code.exe"),
            format!("{program_files_x86}\\Microsoft VS Code\\Code.exe"),
            // cursor / codium variants the user may wire as "vscode"
            format!("{local}\\Programs\\cursor\\Cursor.exe"),
        ],
        "pycharm" => vec![
            // Pinned-by-Toolbox shortcuts (stable PATH across versions).
            format!("{local}\\Programs\\PyCharm Professional\\bin\\pycharm64.exe"),
            format!("{local}\\Programs\\PyCharm\\bin\\pycharm64.exe"),
            // Classic installer locations.
            format!("{program_files}\\JetBrains\\PyCharm\\bin\\pycharm64.exe"),
        ],
        "intellij" => vec![
            format!("{local}\\Programs\\IntelliJ IDEA Ultimate\\bin\\idea64.exe"),
            format!("{local}\\Programs\\IntelliJ IDEA\\bin\\idea64.exe"),
            format!(
                "{program_files}\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe"
            ),
        ],
        "antigravity" => vec![
            // Google Antigravity — released late 2025. Best-guess install
            // paths based on the public preview; user overrides via
            // Settings if we miss it.
            format!("{local}\\Programs\\Antigravity\\Antigravity.exe"),
            format!("{local}\\Antigravity\\Antigravity.exe"),
            format!("{program_files}\\Antigravity\\Antigravity.exe"),
            format!("{program_files}\\Google\\Antigravity\\Antigravity.exe"),
        ],
        _ => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
fn candidate_paths(key: &str) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    // For each "<App>.app/…" tail, look in both /Applications and the
    // per-user ~/Applications (where JetBrains Toolbox drops shortcuts).
    let apps = |tail: &str| -> Vec<String> {
        let mut v = vec![format!("/Applications/{tail}")];
        if !home.is_empty() {
            v.push(format!("{home}/Applications/{tail}"));
        }
        v
    };

    match key {
        "vscode" => {
            let mut v = apps("Visual Studio Code.app/Contents/Resources/app/bin/code");
            v.extend(apps("Cursor.app/Contents/Resources/app/bin/cursor"));
            v.extend(apps("VSCodium.app/Contents/Resources/app/bin/codium"));
            v
        }
        "pycharm" => {
            let mut v = apps("PyCharm.app/Contents/MacOS/pycharm");
            v.extend(apps("PyCharm Professional Edition.app/Contents/MacOS/pycharm"));
            v.extend(apps("PyCharm CE.app/Contents/MacOS/pycharm"));
            v.extend(apps("PyCharm Community Edition.app/Contents/MacOS/pycharm"));
            v
        }
        "intellij" => {
            let mut v = apps("IntelliJ IDEA.app/Contents/MacOS/idea");
            v.extend(apps("IntelliJ IDEA Ultimate.app/Contents/MacOS/idea"));
            v.extend(apps("IntelliJ IDEA CE.app/Contents/MacOS/idea"));
            v.extend(apps("IntelliJ IDEA Community Edition.app/Contents/MacOS/idea"));
            v
        }
        "antigravity" => {
            let mut v = apps("Antigravity.app/Contents/MacOS/Antigravity");
            v.extend(apps("Antigravity.app/Contents/MacOS/Electron"));
            v.extend(apps("Antigravity.app/Contents/Resources/app/bin/antigravity"));
            v
        }
        _ => Vec::new(),
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn candidate_paths(key: &str) -> Vec<String> {
    // Best-effort Linux paths: PATH-installed launchers + snap/flatpak.
    match key {
        "vscode" => vec![
            "/usr/bin/code".into(),
            "/usr/local/bin/code".into(),
            "/snap/bin/code".into(),
            "/usr/bin/cursor".into(),
            "/usr/bin/codium".into(),
        ],
        "pycharm" => vec![
            "/usr/local/bin/pycharm".into(),
            "/snap/bin/pycharm-professional".into(),
            "/snap/bin/pycharm-community".into(),
            "/opt/pycharm/bin/pycharm.sh".into(),
        ],
        "intellij" => vec![
            "/usr/local/bin/idea".into(),
            "/snap/bin/intellij-idea-ultimate".into(),
            "/snap/bin/intellij-idea-community".into(),
            "/opt/idea/bin/idea.sh".into(),
        ],
        "antigravity" => vec![
            "/usr/bin/antigravity".into(),
            "/usr/local/bin/antigravity".into(),
        ],
        _ => Vec::new(),
    }
}

/// Walk `%LOCALAPPDATA%\JetBrains\Toolbox\apps\<app>\ch-<n>\<build>\bin\`
/// to find an installed JetBrains IDE. The Toolbox layout changes
/// across versions; we just pick the first `*.exe` matching the
/// conventional binary name.
#[cfg(target_os = "windows")]
fn detect_jetbrains_toolbox(key: &str) -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let root = PathBuf::from(&local).join("JetBrains\\Toolbox\\apps");
    let (app_prefix, exe_name) = match key {
        "pycharm" => ("PyCharm", "pycharm64.exe"),
        "intellij" => ("IDEA", "idea64.exe"),
        _ => return None,
    };
    let app_dir = std::fs::read_dir(&root).ok()?.flatten().find(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with(app_prefix)
    })?;
    // First channel folder (ch-0 usually).
    let ch = std::fs::read_dir(app_dir.path())
        .ok()?
        .flatten()
        .next()?;
    // First build inside the channel.
    let build = std::fs::read_dir(ch.path())
        .ok()?
        .flatten()
        .next()?;
    let exe = build.path().join("bin").join(exe_name);
    if exe.is_file() {
        Some(exe.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// macOS JetBrains Toolbox stores installs under
/// `~/Library/Application Support/JetBrains/Toolbox/apps/…`. The nesting
/// depth varies across Toolbox versions, so we recursively hunt for a
/// `*.app` bundle containing `Contents/MacOS/<exe>`.
#[cfg(target_os = "macos")]
fn detect_jetbrains_toolbox(key: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let root = PathBuf::from(&home)
        .join("Library/Application Support/JetBrains/Toolbox/apps");
    let exe = match key {
        "pycharm" => "pycharm",
        "intellij" => "idea",
        _ => return None,
    };
    find_toolbox_app(&root, exe, 5)
}

#[cfg(target_os = "macos")]
fn find_toolbox_app(dir: &Path, exe: &str, depth: u32) -> Option<String> {
    if depth == 0 {
        return None;
    }
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if e.file_name().to_string_lossy().ends_with(".app") {
            let cand = p.join("Contents/MacOS").join(exe);
            if cand.is_file() {
                return Some(cand.to_string_lossy().into_owned());
            }
        } else if p.is_dir() {
            if let Some(found) = find_toolbox_app(&p, exe, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn detect_jetbrains_toolbox(_key: &str) -> Option<String> {
    None
}
