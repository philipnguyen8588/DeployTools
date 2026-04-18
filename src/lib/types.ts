/**
 * TypeScript mirrors of the Rust types in `src-tauri/src/models.rs` and
 * related command responses. Kept manually in sync — if you change one,
 * change the other.
 */

export type UUID = string;

export type AuthMethod =
  | { kind: "password"; password: string }
  | { kind: "private_key"; key_path: string; passphrase?: string | null };

export interface Server {
  id: UUID;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  host_key_fingerprint?: string | null;
}

export interface ServerSummary {
  id: UUID;
  name: string;
  host: string;
  port: number;
  user: string;
  auth_kind: "password" | "key";
  has_fingerprint: boolean;
}

export interface Project {
  id: UUID;
  name: string;
  server_id: UUID;
  local_path: string;
  remote_path: string;
  excludes: string[];
  rsync_flags: string;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export interface SessionSummary {
  id: string;
  server_id: UUID;
  project_id: UUID | null;
  terminal_count: number;
  fingerprint: string;
  opened_at: number; // unix ms
}

export interface RemoteEntry {
  name: string;
  full_path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  mtime: number | null;
  mode: string | null;
}

export interface LocalEntry {
  name: string;
  relative_path: string;
  is_dir: boolean;
  size: number;
  mtime: number | null;
  excluded: boolean;
}

export interface LogLine {
  level: "info" | "warn" | "error";
  line: string;
}

export interface ProgressEvent {
  phase: "upload" | "download";
  path: string;
  written: number;
  total: number;
}

export interface FileComparison {
  local_exists: boolean;
  remote_exists: boolean;
  local_size: number;
  remote_size: number;
  local_mtime: number | null;
  remote_mtime: number | null;
  identical: boolean;
  is_binary: boolean;
  local_text: string | null;
  remote_text: string | null;
  unified_diff: string;
}

export type FolderCompareStatus =
  | "only_local"
  | "only_remote"
  | "identical"
  | "differs";

export interface FolderCompareEntry {
  relative_path: string;
  is_dir: boolean;
  status: FolderCompareStatus;
  local_size: number;
  remote_size: number;
  local_mtime: number | null;
  remote_mtime: number | null;
  excluded: boolean;
}

export interface FolderCompareResult {
  entries: FolderCompareEntry[];
  only_local: number;
  only_remote: number;
  differs: number;
  identical: number;
}

// ---------- Cloudflare ----------

export interface CfZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
}

export interface CfDnsRecord {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  /** Present for MX / URI / SRV. */
  priority?: number | null;
  comment?: string | null;
}

export interface CfRecordInput {
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number | null;
  comment?: string | null;
}

export interface GitInfo {
  is_repo: boolean;
  branch: string | null;
  head_short: string | null;
  repo_root: string | null;
}

export interface GitFile {
  relative_path: string;
  status: string;
  exists_on_disk: boolean;
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  time: number;
  summary: string;
}

export type ActivityLevel = "info" | "success" | "warn" | "error";

export interface ActivityLine {
  time_ms: number;
  level: ActivityLevel;
  source: string; // "sftp" | "rsync" | "ssh" | "compare" | "docker" | "docker-logs" | "service" | "snippet"
  message: string;
  session_id: string | null;
  /** Free-form sub-identifier (service name, snippet id). */
  tag?: string | null;
}

// ---------- Snippets ----------

export type SnippetVarKind = "text" | "path" | "secret" | "choice";

export interface SnippetVar {
  key: string;
  label: string;
  default: string | null;
  kind: SnippetVarKind;
  choices: string[];
}

export interface Snippet {
  id: UUID;
  name: string;
  description: string;
  command: string;
  variables: SnippetVar[];
}

// ---------- Services (systemd) ----------

export interface ServiceEntry {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

// ---------- Docker ----------

export interface ComposeService {
  name: string;
  image: string | null;
  build: string | null;
  command: string | null;
  restart: string | null;
  profiles: string[];
  is_oneoff: boolean;
  explicit_oneoff: boolean;
  has_unresolved_vars: boolean;
}

export interface DockerInfo {
  detected: boolean;
  compose_path: string | null;
  services: ComposeService[];
}

export interface ServiceStatus {
  service: string;
  name: string | null;
  image: string | null;
  state: string;
  status: string;
  health: string | null;
  exit_code: number | null;
}

export type DockerAction = "up" | "down" | "restart" | "build" | "pull" | "run_rm";

// ---------- Server metrics ----------

export interface DiskUsage {
  mount: string;
  total_kb: number;
  used_kb: number;
  fs: string;
}

export interface NetIface {
  name: string;
  rx_bytes: number;
  tx_bytes: number;
}

export interface Metrics {
  loadavg: [number, number, number] | null;
  uptime_secs: number | null;
  mem_total_kb: number | null;
  mem_available_kb: number | null;
  disks: DiskUsage[];
  cpu_percent: number | null;
  net: NetIface[];
  raw: string | null;
}

// ---------- Session capabilities ----------

export interface SessionCapabilities {
  compose_v2: boolean | null;
  passwordless_sudo: boolean | null;
  has_systemctl: boolean | null;
  is_root: boolean | null;
  compose_version: string | null;
}
