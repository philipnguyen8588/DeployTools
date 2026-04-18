//! Lightweight server metrics (CPU, memory, disks, load, uptime, network)
//! fetched on demand via a single `sh -c '…'` exec over the SSH session.
//!
//! Parses minimal output from standard Linux tools; we don't assume any
//! sysstat/prometheus tooling. The frontend polls this command on a
//! timer while the Resources tab is the active one, and stops polling
//! when the tab is hidden.

use serde::Serialize;
use tauri::State;

use crate::errors::AppResult;
use crate::ssh::exec;
use crate::state::AppState;

#[derive(Serialize, Clone)]
pub struct Metrics {
    /// Load averages: 1 min, 5 min, 15 min.
    pub loadavg: Option<[f32; 3]>,
    /// Uptime in seconds.
    pub uptime_secs: Option<u64>,
    /// Total / available RAM in kilobytes (as reported by /proc/meminfo).
    pub mem_total_kb: Option<u64>,
    pub mem_available_kb: Option<u64>,
    /// Per-disk usage.
    pub disks: Vec<DiskUsage>,
    /// Aggregate CPU utilisation in percent (0-100). Sampled over ~1s.
    pub cpu_percent: Option<f32>,
    /// Per-interface network stats.
    pub net: Vec<NetIface>,
    /// Raw stdout if nothing parsed (for debugging).
    pub raw: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DiskUsage {
    pub mount: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub fs: String,
}

#[derive(Serialize, Clone)]
pub struct NetIface {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

/// One-shot metric snapshot. Intentionally cheap (~1 second to sample CPU).
#[tauri::command]
pub async fn fetch_metrics(
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<Metrics> {
    let session = state.sessions.get(&session_id)?;

    // Glue script: we sample /proc/stat twice 1s apart for CPU.
    // Everything is wrapped so we can parse sections.
    let script = r#"
cat /proc/loadavg 2>/dev/null; echo '---UPTIME---'
cat /proc/uptime 2>/dev/null; echo '---MEMINFO---'
cat /proc/meminfo 2>/dev/null; echo '---DF---'
df -P -BK -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2; echo '---CPU1---'
head -1 /proc/stat 2>/dev/null; sleep 1; echo '---CPU2---'
head -1 /proc/stat 2>/dev/null; echo '---NET---'
cat /proc/net/dev 2>/dev/null | tail -n +3
"#;

    let argv = vec!["sh".to_string(), "-c".into(), script.to_string()];
    let (stdout, _stderr, _code) =
        exec::run_capturing(session, None, &argv, 256 * 1024).await?;
    Ok(parse(&stdout))
}

fn parse(out: &str) -> Metrics {
    let mut m = Metrics {
        loadavg: None,
        uptime_secs: None,
        mem_total_kb: None,
        mem_available_kb: None,
        disks: Vec::new(),
        cpu_percent: None,
        net: Vec::new(),
        raw: None,
    };

    let mut sections: std::collections::HashMap<&str, Vec<&str>> =
        Default::default();
    let mut current = "LOADAVG";
    sections.insert(current, Vec::new());
    for line in out.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("---").and_then(|s| s.strip_suffix("---")) {
            current = match name {
                "UPTIME" => "UPTIME",
                "MEMINFO" => "MEMINFO",
                "DF" => "DF",
                "CPU1" => "CPU1",
                "CPU2" => "CPU2",
                "NET" => "NET",
                _ => current,
            };
            sections.entry(current).or_default();
            continue;
        }
        sections.entry(current).or_default().push(line);
    }

    // loadavg
    if let Some(lines) = sections.get("LOADAVG") {
        if let Some(first) = lines.first() {
            let parts: Vec<&str> = first.split_whitespace().collect();
            if parts.len() >= 3 {
                let a = parts[0].parse::<f32>().ok();
                let b = parts[1].parse::<f32>().ok();
                let c = parts[2].parse::<f32>().ok();
                if let (Some(a), Some(b), Some(c)) = (a, b, c) {
                    m.loadavg = Some([a, b, c]);
                }
            }
        }
    }

    // uptime
    if let Some(lines) = sections.get("UPTIME") {
        if let Some(first) = lines.first() {
            let parts: Vec<&str> = first.split_whitespace().collect();
            if let Some(up) = parts.first().and_then(|s| s.parse::<f64>().ok()) {
                m.uptime_secs = Some(up as u64);
            }
        }
    }

    // meminfo
    if let Some(lines) = sections.get("MEMINFO") {
        for line in lines {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                m.mem_total_kb = parse_kb(rest);
            } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                m.mem_available_kb = parse_kb(rest);
            }
        }
    }

    // df
    if let Some(lines) = sections.get("DF") {
        for line in lines {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 6 {
                // Filesystem  1K-blocks  Used  Available  Capacity  Mounted
                let total: Option<u64> = parts[1]
                    .trim_end_matches('K')
                    .parse()
                    .ok();
                let used: Option<u64> = parts[2].trim_end_matches('K').parse().ok();
                if let (Some(total), Some(used)) = (total, used) {
                    m.disks.push(DiskUsage {
                        mount: parts[5].to_string(),
                        total_kb: total,
                        used_kb: used,
                        fs: parts[0].to_string(),
                    });
                }
            }
        }
    }

    // cpu delta
    let cpu1 = sections
        .get("CPU1")
        .and_then(|l| l.first())
        .and_then(|l| parse_cpu_stat(l));
    let cpu2 = sections
        .get("CPU2")
        .and_then(|l| l.first())
        .and_then(|l| parse_cpu_stat(l));
    if let (Some(a), Some(b)) = (cpu1, cpu2) {
        let total_d = b.total.saturating_sub(a.total) as f32;
        let idle_d = b.idle.saturating_sub(a.idle) as f32;
        if total_d > 0.0 {
            let pct = ((total_d - idle_d) / total_d * 100.0).clamp(0.0, 100.0);
            m.cpu_percent = Some(pct);
        }
    }

    // network — filter out lo + veth noise
    if let Some(lines) = sections.get("NET") {
        for line in lines {
            let (name, rest) = match line.split_once(':') {
                Some((a, b)) => (a.trim(), b),
                None => continue,
            };
            if name == "lo" || name.starts_with("veth") || name.starts_with("docker") {
                continue;
            }
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 10 {
                let rx = parts[0].parse::<u64>().unwrap_or(0);
                let tx = parts[8].parse::<u64>().unwrap_or(0);
                m.net.push(NetIface {
                    name: name.to_string(),
                    rx_bytes: rx,
                    tx_bytes: tx,
                });
            }
        }
    }

    if m.loadavg.is_none() && m.mem_total_kb.is_none() && m.disks.is_empty() {
        // Probably a non-Linux box (BusyBox ash with missing /proc? MacOS?).
        m.raw = Some(out.chars().take(2000).collect());
    }
    m
}

#[derive(Clone, Copy)]
struct CpuStat {
    total: u64,
    idle: u64,
}

fn parse_cpu_stat(line: &str) -> Option<CpuStat> {
    // `cpu  user nice system idle iowait irq softirq steal guest guest_nice`
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 5 || !parts[0].starts_with("cpu") {
        return None;
    }
    let nums: Vec<u64> = parts[1..]
        .iter()
        .filter_map(|s| s.parse::<u64>().ok())
        .collect();
    if nums.len() < 4 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    Some(CpuStat { total, idle })
}

fn parse_kb(s: &str) -> Option<u64> {
    s.trim()
        .trim_end_matches(" kB")
        .split_whitespace()
        .next()
        .and_then(|n| n.parse::<u64>().ok())
}
