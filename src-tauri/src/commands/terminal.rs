//! Terminal IPC — open / write / resize / close.

use serde::Serialize;
use tauri::State;

use crate::errors::AppResult;
use crate::ssh::terminal;
use crate::state::AppState;

#[tauri::command]
pub async fn term_open(
    session_id: String,
    terminal_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let session = state.sessions.get(&session_id)?;
    terminal::open(session, terminal_id, cols, rows).await
}

/// Live system information for the welcome banner (an Ubuntu-MOTD-style
/// summary we assemble ourselves, rather than relying on the server's
/// pam_motd which isn't emitted over our interactive PTY). All fields are
/// optional so a partial probe still renders what it found.
#[derive(Serialize, Default)]
pub struct SysInfo {
    /// e.g. "Welcome to Ubuntu 26.04.1 LTS (GNU/Linux 7.0.0-30-generic x86_64)"
    pub welcome: Option<String>,
    /// Server-local timestamp string.
    pub date: Option<String>,
    pub load: Option<String>,
    pub processes: Option<String>,
    pub users: Option<String>,
    /// e.g. "13.8% of 96.88GB"
    pub disk: Option<String>,
    /// e.g. "20%"
    pub memory: Option<String>,
    /// e.g. "0%"
    pub swap: Option<String>,
    /// e.g. "222.255.174.128 (ens160)"
    pub ipv4: Option<String>,
}

const SYSINFO_SCRIPT: &str = r#"
{ . /etc/os-release 2>/dev/null; printf 'OS=%s\n' "${PRETTY_NAME:-Linux}"; }
printf 'KERNEL=%s\n' "$(uname -r 2>/dev/null)"
printf 'ARCH=%s\n' "$(uname -m 2>/dev/null)"
printf 'DATE=%s\n' "$(date '+%a %b %d %I:%M:%S %p %Z %Y' 2>/dev/null)"
printf 'LOAD=%s\n' "$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
printf 'PROCS=%s\n' "$(ls -d /proc/[0-9]* 2>/dev/null | wc -l | tr -d ' ')"
printf 'USERS=%s\n' "$(who 2>/dev/null | wc -l | tr -d ' ')"
df -B1 / 2>/dev/null | awk 'NR==2{printf "DISK_USED=%s\nDISK_SIZE=%s\n",$3,$2}'
awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}/^SwapTotal:/{st=$2}/^SwapFree:/{sf=$2}END{if(t>0)printf "MEM_PCT=%.0f\n",(t-a)*100/t; if(st>0)printf "SWAP_PCT=%.0f\n",(st-sf)*100/st; else print "SWAP_PCT=0"}' /proc/meminfo 2>/dev/null
ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1{split($4,a,"/"); printf "IP_IFACE=%s\nIP_ADDR=%s\n",$2,a[1]}'
"#;

/// Probe the connected server for the banner's system-information block.
#[tauri::command]
pub async fn term_sysinfo(
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<SysInfo> {
    let session = state.sessions.get(&session_id)?;
    let argv = vec!["sh".to_string(), "-c".to_string(), SYSINFO_SCRIPT.to_string()];
    let (out, _err, _exit) =
        crate::ssh::exec::run_capturing(session, None, &argv, 16 * 1024).await?;

    let mut kv = std::collections::HashMap::new();
    for line in out.lines() {
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim();
            if !v.is_empty() {
                kv.insert(k.trim().to_string(), v.to_string());
            }
        }
    }
    let get = |k: &str| kv.get(k).cloned();

    let mut info = SysInfo::default();
    if let Some(os) = get("OS") {
        let kernel = get("KERNEL").unwrap_or_default();
        let arch = get("ARCH").unwrap_or_default();
        info.welcome = Some(if kernel.is_empty() {
            format!("Welcome to {os}")
        } else {
            format!("Welcome to {os} (GNU/Linux {kernel} {arch})")
        });
    }
    info.date = get("DATE");
    info.load = get("LOAD");
    info.processes = get("PROCS");
    info.users = get("USERS");
    info.memory = get("MEM_PCT").map(|p| format!("{p}%"));
    info.swap = get("SWAP_PCT").map(|p| format!("{p}%"));
    if let (Some(used), Some(size)) = (get("DISK_USED"), get("DISK_SIZE")) {
        if let (Ok(u), Ok(s)) = (used.parse::<f64>(), size.parse::<f64>()) {
            if s > 0.0 {
                let pct = u / s * 100.0;
                let total_gb = s / 1_000_000_000.0;
                info.disk = Some(format!("{pct:.1}% of {total_gb:.2}GB"));
            }
        }
    }
    if let Some(addr) = get("IP_ADDR") {
        info.ipv4 = Some(match get("IP_IFACE") {
            Some(iface) => format!("{addr} ({iface})"),
            None => addr,
        });
    }
    Ok(info)
}

#[tauri::command]
pub async fn term_write(
    session_id: String,
    terminal_id: String,
    data: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.sessions.get(&session_id)?;
    terminal::write(&session, &terminal_id, data.into_bytes())
}

#[tauri::command]
pub async fn term_resize(
    session_id: String,
    terminal_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.sessions.get(&session_id)?;
    terminal::resize(&session, &terminal_id, cols, rows)
}

#[tauri::command]
pub async fn term_close(
    session_id: String,
    terminal_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.sessions.get(&session_id)?;
    terminal::close(&session, &terminal_id)
}
