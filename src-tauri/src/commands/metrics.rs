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
    /// Top running processes — already sorted by CPU desc on the server
    /// side, but the frontend offers re-sort by column (CPU / RAM / PID).
    pub processes: Vec<ProcessInfo>,
    /// Raw stdout if nothing parsed (for debugging).
    pub raw: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub user: String,
    /// Percent of a single CPU (0-100+ for multi-threaded procs).
    pub cpu_percent: f32,
    /// Percent of total system RAM.
    pub mem_percent: f32,
    /// Resident set size in kilobytes.
    pub rss_kb: u64,
    pub command: String,
    /// Set when the process runs inside a container.
    /// `"docker" | "podman" | "kubepods" | "containerd" | "lxc"`.
    pub container_kind: Option<String>,
    /// Short container id (12 hex chars) for docker/podman/kubepods, or
    /// an LXC container name. `None` for host processes.
    pub container_id: Option<String>,
    /// Friendly name looked up from `docker ps` (e.g. `myapp_web_1`).
    /// Only populated when the user has docker query access on the host.
    pub container_name: Option<String>,
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
    //
    // The `ps` call uses `--sort=-pcpu` to pre-sort by CPU desc and
    // `head -50` to cap output.
    //
    // Two extra sections tag container processes:
    //   ---CGROUP---   one line per host PID, `pid<TAB>cgroup-path`.
    //                  We derive container kind + id from the path.
    //   ---DOCKER_PS--- `id<TAB>name` mapping for docker containers
    //                  when the SSH user has docker access; missing if
    //                  docker is absent or permissions are insufficient.
    //                  stderr of `docker ps` is silenced so permission
    //                  errors don't pollute the output stream.
    let script = r#"
cat /proc/loadavg 2>/dev/null; echo '---UPTIME---'
cat /proc/uptime 2>/dev/null; echo '---MEMINFO---'
cat /proc/meminfo 2>/dev/null; echo '---DF---'
df -P -BK -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2; echo '---CPU1---'
head -1 /proc/stat 2>/dev/null; sleep 1; echo '---CPU2---'
head -1 /proc/stat 2>/dev/null; echo '---NET---'
cat /proc/net/dev 2>/dev/null | tail -n +3; echo '---PS---'
ps -eo pid=,user=,pcpu=,pmem=,rss=,comm= --sort=-pcpu 2>/dev/null | head -50; echo '---CGROUP---'
awk 'FNR==1 { n=split(FILENAME,a,"/"); pid=a[n-1]; print pid"\t"$0 }' /proc/[0-9]*/cgroup 2>/dev/null; echo '---DOCKER_PS---'
docker ps --no-trunc --format '{{.ID}}	{{.Names}}' 2>/dev/null
"#;

    let argv = vec!["sh".to_string(), "-c".into(), script.to_string()];
    let (stdout, _stderr, _code) =
        exec::run_capturing(session, None, &argv, 256 * 1024).await?;
    Ok(parse(&stdout))
}

/// Lightweight one-shot disk usage — just `df`, without the ~1s CPU
/// sampling and `ps`/`docker` overhead of `fetch_metrics`. The status bar
/// calls this once per connection to show disk usage.
#[tauri::command]
pub async fn fetch_disk_usage(
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<DiskUsage>> {
    let session = state.sessions.get(&session_id)?;
    let script = "df -P -BK -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2";
    let argv = vec!["sh".to_string(), "-c".into(), script.to_string()];
    let (stdout, _stderr, _code) =
        exec::run_capturing(session, None, &argv, 64 * 1024).await?;
    Ok(parse_df(stdout.lines()))
}

/// Parse `df -P -BK` rows (header already stripped) into `DiskUsage`.
///   Filesystem  1K-blocks  Used  Available  Capacity  Mounted-on
fn parse_df<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<DiskUsage> {
    let mut disks = Vec::new();
    for line in lines {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 6 {
            let total: Option<u64> = parts[1].trim_end_matches('K').parse().ok();
            let used: Option<u64> = parts[2].trim_end_matches('K').parse().ok();
            if let (Some(total), Some(used)) = (total, used) {
                disks.push(DiskUsage {
                    mount: parts[5].to_string(),
                    total_kb: total,
                    used_kb: used,
                    fs: parts[0].to_string(),
                });
            }
        }
    }
    disks
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
        processes: Vec::new(),
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
                "PS" => "PS",
                "CGROUP" => "CGROUP",
                "DOCKER_PS" => "DOCKER_PS",
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
        m.disks = parse_df(lines.iter().copied());
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

    // Build a pid → cgroup-path map first so we can enrich ProcessInfo
    // entries in a single pass below.
    let mut cgroup_by_pid: std::collections::HashMap<u32, String> =
        std::collections::HashMap::new();
    if let Some(lines) = sections.get("CGROUP") {
        for line in lines {
            // Format: `<pid>\t<cgroup-line>`. cgroup line is one of:
            //   v2: `0::/system.slice/docker-abcdef.scope`
            //   v1: `12:cpu:/docker/abcdef...`
            let mut it = line.splitn(2, '\t');
            let pid: Option<u32> = it.next().and_then(|s| s.trim().parse().ok());
            let rest = it.next().unwrap_or("");
            if let Some(pid) = pid {
                cgroup_by_pid.insert(pid, rest.to_string());
            }
        }
    }

    // Docker container id → friendly name map (may be empty).
    let mut docker_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let Some(lines) = sections.get("DOCKER_PS") {
        for line in lines {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // `docker ps` might emit with a tab OR whitespace depending on
            // shell quoting. Accept either.
            let (id_full, name) = match line.split_once('\t') {
                Some(p) => p,
                None => match line.split_once(char::is_whitespace) {
                    Some(p) => p,
                    None => continue,
                },
            };
            let id_full = id_full.trim();
            let name = name.trim();
            if id_full.is_empty() || name.is_empty() {
                continue;
            }
            // Index by the full id AND the short (first 12 chars) form
            // so lookup works no matter which id the cgroup path carries.
            let short: String = id_full.chars().take(12).collect();
            docker_names.insert(short, name.to_string());
            docker_names.insert(id_full.to_string(), name.to_string());
        }
    }

    // processes — output format:
    //   pid user pcpu pmem rss comm
    // where `comm` can contain spaces if the process renamed itself;
    // we consume the first 5 whitespace-separated tokens and take the
    // rest as the command.
    if let Some(lines) = sections.get("PS") {
        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut it = trimmed.split_whitespace();
            let pid = it.next().and_then(|s| s.parse::<u32>().ok());
            let user = it.next();
            let pcpu = it.next().and_then(|s| s.parse::<f32>().ok());
            let pmem = it.next().and_then(|s| s.parse::<f32>().ok());
            let rss = it.next().and_then(|s| s.parse::<u64>().ok());
            let cmd: String = it.collect::<Vec<_>>().join(" ");
            if let (Some(pid), Some(user), Some(pcpu), Some(pmem), Some(rss)) =
                (pid, user, pcpu, pmem, rss)
            {
                if cmd.is_empty() {
                    continue;
                }
                // Container detection from cgroup, if we have the path.
                let (container_kind, container_id) = cgroup_by_pid
                    .get(&pid)
                    .and_then(|p| detect_container(p))
                    .unwrap_or((None, None));
                let container_name = container_id
                    .as_deref()
                    .and_then(|id| docker_names.get(id).cloned());

                m.processes.push(ProcessInfo {
                    pid,
                    user: user.to_string(),
                    cpu_percent: pcpu,
                    mem_percent: pmem,
                    rss_kb: rss,
                    command: cmd,
                    container_kind,
                    container_id,
                    container_name,
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

/// Inspect a `/proc/<pid>/cgroup` line and report which container runtime
/// (if any) the process belongs to, plus its short id/name.
///
/// Recognised patterns, covering cgroup v1 (`HIERARCHY:CTRL:/path`) and
/// cgroup v2 (`0::/path`) across the common runtimes:
///
/// * Docker:     `/docker/<64hex>` or `/docker-<64hex>.scope`
/// * Podman:     `/libpod-<64hex>.scope` or `/machine.slice/libpod-…`
/// * Kubernetes: `/kubepods/.../pod<uuid>/<64hex>` or
///               `cri-containerd-<64hex>.scope` inside kubepods
/// * containerd: `/.../<64hex>` under `/system.slice/containerd.service`
/// * LXC:        `/lxc/<name>` (name may be non-hex)
///
/// Anything that doesn't match (or an empty path) returns `(None, None)`
/// so the caller can treat it as a host-level process.
fn detect_container(cgroup_path: &str) -> Option<(Option<String>, Option<String>)> {
    let path = cgroup_path.trim();

    // Kubernetes first — its cgroups nest `docker-<HASH>.scope` or
    // `cri-containerd-<HASH>.scope` inside `kubepods`, so checking
    // docker first would mislabel k8s pods as plain docker.
    if path.contains("/kubepods") {
        for seg in path.rsplit('/') {
            let seg = seg.trim_end_matches(".scope");
            let tail = seg.rsplit('-').next().unwrap_or(seg);
            if let Some(id) = take_hex(tail) {
                return Some((Some("kubepods".into()), Some(id)));
            }
        }
    }
    // Docker (cgroupfs driver): `/docker/<HASH>`
    if let Some(idx) = path.find("/docker/") {
        if let Some(id) = take_hex(&path[idx + "/docker/".len()..]) {
            return Some((Some("docker".into()), Some(id)));
        }
    }
    // Docker (systemd driver): `docker-<HASH>.scope`
    if let Some(idx) = path.find("docker-") {
        if let Some(id) = take_hex(&path[idx + "docker-".len()..]) {
            return Some((Some("docker".into()), Some(id)));
        }
    }
    // Podman: `libpod-<HASH>.scope`
    if let Some(idx) = path.find("libpod-") {
        if let Some(id) = take_hex(&path[idx + "libpod-".len()..]) {
            return Some((Some("podman".into()), Some(id)));
        }
    }
    // Plain containerd under its own slice/scope (nerdctl, non-k8s).
    if path.contains("containerd") {
        for seg in path.rsplit('/') {
            let seg = seg.trim_end_matches(".scope");
            let tail = seg.rsplit('-').next().unwrap_or(seg);
            if let Some(id) = take_hex(tail) {
                return Some((Some("containerd".into()), Some(id)));
            }
        }
    }
    // LXC — container name isn't a hex id; keep verbatim.
    if let Some(idx) = path.find("/lxc/") {
        let rest = &path[idx + "/lxc/".len()..];
        let name: String = rest.chars().take_while(|c| *c != '/' && *c != '.').collect();
        if !name.is_empty() {
            return Some((Some("lxc".into()), Some(name)));
        }
    }
    None
}

/// Consume up to 12 hex characters from the start of `s`. Returns `None`
/// if fewer than 12 hex chars are available (not a container id).
fn take_hex(s: &str) -> Option<String> {
    let out: String = s
        .chars()
        .take_while(|c| c.is_ascii_hexdigit())
        .take(12)
        .collect();
    if out.len() == 12 {
        Some(out)
    } else {
        None
    }
}
