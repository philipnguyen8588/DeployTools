/**
 * Typed wrappers around the Tauri IPC commands. All command names must
 * match the handlers registered in `src-tauri/src/lib.rs` exactly.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  CfDnsRecord,
  CfRecordInput,
  CfZone,
  DiskUsage,
  DockerAction,
  DockerInfo,
  Metrics,
  FileComparison,
  FolderCompareResult,
  GitCommit,
  GitFile,
  GitInfo,
  LocalEntry,
  Project,
  RemoteEntry,
  ServiceEntry,
  ServiceStatus,
  SessionCapabilities,
  Server,
  ServerGroup,
  ServerSummary,
  SessionSummary,
  Snippet,
  SysInfo,
  UUID,
  VaultStatus,
} from "./types";

// --- Vault ---

export const vaultStatus = () => invoke<VaultStatus>("vault_status");
export const vaultInit = (masterPassword: string) =>
  invoke<void>("vault_init", { masterPassword });
export const vaultUnlock = (masterPassword: string) =>
  invoke<void>("vault_unlock", { masterPassword });
export const vaultLock = () => invoke<void>("vault_lock");
export const vaultChangePassword = (oldPassword: string, newPassword: string) =>
  invoke<void>("vault_change_password", { oldPassword, newPassword });

// --- Servers ---

export const listServers = () => invoke<ServerSummary[]>("list_servers");
export const getServer = (id: UUID) => invoke<Server>("get_server", { id });
export const saveServer = (server: Server) =>
  invoke<Server>("save_server", { server });
export const deleteServer = (id: UUID) => invoke<void>("delete_server", { id });
export const testConnection = (id: UUID) =>
  invoke<string>("test_connection", { id });
export const testConnectionConfig = (server: Server) =>
  invoke<string>("test_connection_config", { server });
/** Drag-drop reorder. Called once per affected group after a drop. */
export const reorderServers = (groupId: UUID | null, ids: UUID[]) =>
  invoke<void>("reorder_servers", { groupId, ids });

// --- Server groups ---

export const listGroups = () => invoke<ServerGroup[]>("list_groups");
export const saveGroup = (group: ServerGroup) =>
  invoke<ServerGroup>("save_group", { group });
export const deleteGroup = (id: UUID) => invoke<void>("delete_group", { id });
export const reorderGroups = (ids: UUID[]) =>
  invoke<void>("reorder_groups", { ids });

// --- Projects ---

export const listProjects = () => invoke<Project[]>("list_projects");
export const saveProject = (project: Project) =>
  invoke<Project>("save_project", { project });
export const deleteProject = (id: UUID) =>
  invoke<void>("delete_project", { id });
export const reorderProjects = (serverId: UUID, ids: UUID[]) =>
  invoke<void>("reorder_projects", { serverId, ids });

// --- Sessions ---

export const openSession = (serverId: UUID, projectId?: UUID | null) =>
  invoke<SessionSummary>("open_session", { serverId, projectId: projectId ?? null });
export const closeSession = (sessionId: string) =>
  invoke<void>("close_session", { sessionId });
export const listSessions = () => invoke<SessionSummary[]>("list_sessions");

// --- Terminal ---

export const termOpen = (
  sessionId: string,
  terminalId: string,
  cols: number,
  rows: number,
) => invoke<string>("term_open", { sessionId, terminalId, cols, rows });
/** Probe the server for the welcome banner's system-info block. */
export const termSysinfo = (sessionId: string) =>
  invoke<SysInfo>("term_sysinfo", { sessionId });
export const termWrite = (sessionId: string, terminalId: string, data: string) =>
  invoke<void>("term_write", { sessionId, terminalId, data });
export const termResize = (
  sessionId: string,
  terminalId: string,
  cols: number,
  rows: number,
) => invoke<void>("term_resize", { sessionId, terminalId, cols, rows });
export const termClose = (sessionId: string, terminalId: string) =>
  invoke<void>("term_close", { sessionId, terminalId });

// --- SFTP ---

export const sftpList = (sessionId: string, path: string) =>
  invoke<RemoteEntry[]>("sftp_list", { sessionId, path });
export const sftpMkdir = (sessionId: string, path: string) =>
  invoke<void>("sftp_mkdir", { sessionId, path });
export const sftpRm = (sessionId: string, path: string, recursive: boolean) =>
  invoke<void>("sftp_rm", { sessionId, path, recursive });
export const sftpRename = (sessionId: string, from: string, to: string) =>
  invoke<void>("sftp_rename", { sessionId, from, to });
export const sftpUpload = (
  sessionId: string,
  localPath: string,
  remotePath: string,
) => invoke<void>("sftp_upload", { sessionId, localPath, remotePath });
export const sftpDownload = (
  sessionId: string,
  remotePath: string,
  localPath: string,
) => invoke<void>("sftp_download", { sessionId, remotePath, localPath });

// --- Deploy ---

export const deployFile = (
  projectId: UUID,
  relativePath: string,
  sessionId?: string | null,
) =>
  invoke<void>("deploy_file", {
    projectId,
    relativePath,
    sessionId: sessionId ?? null,
  });
export const deployFiles = (
  projectId: UUID,
  relativePaths: string[],
  sessionId?: string | null,
  jobId?: string | null,
) =>
  invoke<number>("deploy_files", {
    projectId,
    relativePaths,
    sessionId: sessionId ?? null,
    jobId: jobId ?? null,
  });
export const deployFolder = (
  projectId: UUID,
  relativePath: string,
  sessionId?: string | null,
  jobId?: string | null,
) =>
  invoke<number>("deploy_folder", {
    projectId,
    relativePath,
    sessionId: sessionId ?? null,
    jobId: jobId ?? null,
  });
export const deployRsync = (projectId: UUID, dryRun: boolean) =>
  invoke<number>("deploy_rsync", { projectId, dryRun });
export const deploySync = (
  projectId: UUID,
  sessionId: string | null,
  deleteExtraneous: boolean,
  jobId?: string | null,
) =>
  invoke<{ uploaded: number; deleted: number; unchanged: number }>(
    "deploy_sync",
    { projectId, sessionId, deleteExtraneous, jobId: jobId ?? null },
  );
export const deploySmartSync = (
  projectId: UUID,
  sessionId: string | null,
  deleteExtraneous: boolean,
  jobId?: string | null,
) =>
  invoke<{ engine: string; summary: string }>("deploy_smart_sync", {
    projectId,
    sessionId,
    deleteExtraneous,
    jobId: jobId ?? null,
  });
export const downloadToMapped = (
  projectId: UUID,
  sessionId: string,
  remotePaths: string[],
  jobId?: string | null,
) =>
  invoke<{ downloaded: number; skipped: number }>("download_to_mapped", {
    projectId,
    sessionId,
    remotePaths,
    jobId: jobId ?? null,
  });
export const cancelDeploy = (jobId: string) =>
  invoke<void>("cancel_deploy", { jobId });
export const downloadTo = (
  sessionId: string,
  remotePath: string,
  localDir: string,
) => invoke<number>("download_to", { sessionId, remotePath, localDir });
export const listLocalTree = (projectId: UUID, relativePath: string) =>
  invoke<LocalEntry[]>("list_local_tree", { projectId, relativePath });
export const compareFile = (
  projectId: UUID,
  relativePath: string,
  sessionId: string,
) =>
  invoke<FileComparison>("compare_file", {
    projectId,
    relativePath,
    sessionId,
  });
export const compareFolder = (
  projectId: UUID,
  relativePath: string,
  sessionId: string,
) =>
  invoke<FolderCompareResult>("compare_folder", {
    projectId,
    relativePath,
    sessionId,
  });

// --- Snippets ---
export const snippetList = () => invoke<Snippet[]>("snippet_list");
export const snippetSave = (snippet: Snippet) =>
  invoke<Snippet>("snippet_save", { snippet });
export const snippetDelete = (id: UUID) => invoke<void>("snippet_delete", { id });
export const snippetRun = (
  sessionId: string,
  snippetId: UUID,
  vars: Record<string, string>,
) => invoke<number>("snippet_run", { sessionId, snippetId, vars });
/** Return the resolved command string (built-ins + user vars substituted).
 *  Intended for pasting into the active interactive terminal. */
export const snippetResolve = (
  sessionId: string,
  snippetId: UUID,
  vars: Record<string, string>,
) =>
  invoke<string>("snippet_resolve", { sessionId, snippetId, vars });

// --- Terminal command history (per-server) ---
export interface TerminalHistoryEntry {
  id: UUID;
  server_id: UUID;
  command: string;
  time_ms: number;
  /** "user" (typed in the terminal) or "mcp" (an AI agent via run_command). */
  source: "user" | "mcp";
}
export const historyList = (serverId: UUID, limit?: number) =>
  invoke<TerminalHistoryEntry[]>("history_list", { serverId, limit });
export const historyAdd = (serverId: UUID, command: string) =>
  invoke<void>("history_add", { serverId, command });
export const historyClear = (serverId: UUID) =>
  invoke<void>("history_clear", { serverId });

// --- Metrics ---
export const fetchMetrics = (sessionId: string) =>
  invoke<Metrics>("fetch_metrics", { sessionId });

/** Lightweight disk-only usage (just `df`) — used by the status bar. */
export const fetchDiskUsage = (sessionId: string) =>
  invoke<DiskUsage[]>("fetch_disk_usage", { sessionId });

// --- Services (systemd) ---
export const serviceList = (sessionId: string) =>
  invoke<ServiceEntry[]>("service_list", { sessionId });
export const serviceAction = (
  sessionId: string,
  name: string,
  action: "start" | "stop" | "restart" | "reload" | "status",
) => invoke<number>("service_action", { sessionId, name, action });

// --- Docker Compose ---
export const dockerComposeInfo = (projectId: UUID) =>
  invoke<DockerInfo>("docker_compose_info", { projectId });
export const dockerComposePs = (sessionId: string, projectId: UUID) =>
  invoke<ServiceStatus[]>("docker_compose_ps", { sessionId, projectId });
export const dockerComposeAction = (
  sessionId: string,
  projectId: UUID,
  action: DockerAction,
  service?: string | null,
  extraArgs?: string[],
) =>
  invoke<number>("docker_compose_action", {
    sessionId,
    projectId,
    action,
    service: service ?? null,
    extraArgs: extraArgs ?? null,
  });
export const dockerComposeLogsFollow = (
  sessionId: string,
  projectId: UUID,
  service?: string | null,
) =>
  invoke<void>("docker_compose_logs_follow", {
    sessionId,
    projectId,
    service: service ?? null,
  });
export const dockerComposeLogsStop = (sessionId: string, service?: string | null) =>
  invoke<void>("docker_compose_logs_stop", {
    sessionId,
    service: service ?? null,
  });
export const dockerComposeExecShell = (
  sessionId: string,
  projectId: UUID,
  service: string,
) =>
  invoke<string>("docker_compose_exec_shell", { sessionId, projectId, service });
export const sessionCapabilities = (sessionId: string) =>
  invoke<SessionCapabilities>("session_capabilities", { sessionId });

// --- Cloudflare ---
export const cfHasToken = () => invoke<boolean>("cf_has_token");
export const cfSetToken = (token: string) =>
  invoke<string>("cf_set_token", { token });
export const cfClearToken = () => invoke<void>("cf_clear_token");
export const cfVerify = () => invoke<string>("cf_verify");
export const cfListZones = () => invoke<CfZone[]>("cf_list_zones");
export const cfListRecords = (zoneId: string) =>
  invoke<CfDnsRecord[]>("cf_list_records", { zoneId });
export const cfUpdateRecord = (
  zoneId: string,
  recordId: string,
  payload: CfRecordInput,
) =>
  invoke<CfDnsRecord>("cf_update_record", { zoneId, recordId, payload });
export const cfCreateRecord = (zoneId: string, payload: CfRecordInput) =>
  invoke<CfDnsRecord>("cf_create_record", { zoneId, payload });
export const cfDeleteRecord = (zoneId: string, recordId: string) =>
  invoke<void>("cf_delete_record", { zoneId, recordId });

// --- Git ---
export const gitInfo = (projectId: UUID) =>
  invoke<GitInfo>("git_info", { projectId });
export const gitStatus = (projectId: UUID) =>
  invoke<GitFile[]>("git_status", { projectId });
export const gitLog = (projectId: UUID, limit?: number) =>
  invoke<GitCommit[]>("git_log", { projectId, limit: limit ?? 100 });
export const gitFilesInCommit = (projectId: UUID, hash: string) =>
  invoke<GitFile[]>("git_files_in_commit", { projectId, hash });

// --- System terminal (native OS shell / SSH window) ---
export const openLocalTerminal = (cwd?: string) =>
  invoke<void>("open_local_terminal", { cwd });
export const openSshTerminal = (serverId: UUID, remotePath?: string) =>
  invoke<void>("open_ssh_terminal", { serverId, remotePath });
export const revealPath = (path: string) =>
  invoke<void>("reveal_path", { path });

// --- MCP server (AI agent control) ---
export interface McpConfig {
  enabled: boolean;
  port: number;
  token: string;
  running: boolean;
}
export const mcpGetConfig = () => invoke<McpConfig>("mcp_get_config");
export const mcpSetEnabled = (enabled: boolean) =>
  invoke<void>("mcp_set_enabled", { enabled });
export const mcpRegenerateToken = () => invoke<string>("mcp_regenerate_token");

export interface McpCommandPolicy {
  mode: string; // "off" | "deny" | "disabled"
  denylist: string[];
  defaults: string[];
}
export const mcpGetCommandPolicy = () =>
  invoke<McpCommandPolicy>("mcp_get_command_policy");
export const mcpSetCommandPolicy = (mode: string, denylist: string[]) =>
  invoke<void>("mcp_set_command_policy", { mode, denylist });

export interface McpActivityEntry {
  id: UUID;
  time_ms: number;
  tool: string;
  project: string | null;
  detail: string;
}
export const mcpActivityList = (limit?: number) =>
  invoke<McpActivityEntry[]>("mcp_activity_list", { limit });
export const mcpActivityClear = () => invoke<void>("mcp_activity_clear");

// --- SSH local-forward tunnels ---
export interface TunnelInfo {
  id: string;
  session_id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
}
export const startTunnel = (
  sessionId: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
) =>
  invoke<TunnelInfo>("start_tunnel", {
    sessionId,
    localPort,
    remoteHost,
    remotePort,
  });
export const stopTunnel = (tunnelId: string) =>
  invoke<void>("stop_tunnel", { tunnelId });
export const listTunnels = (sessionId?: string) =>
  invoke<TunnelInfo[]>("list_tunnels", { sessionId: sessionId ?? null });

// --- IDE launcher (VSCode / PyCharm / IntelliJ / Antigravity) ---
export interface IdeEntry {
  key: string;
  label: string;
  /** User-configured absolute path, or `null` if not pinned. */
  configured: string | null;
  /** Auto-detected path from the filesystem scan. */
  detected: string | null;
  /** True for the hardcoded built-in set (VSCode / PyCharm / …).
   *  Custom entries can be fully removed from the Settings dialog;
   *  built-ins only support Reset (which drops the user override and
   *  falls back to the auto-detected path). */
  is_builtin: boolean;
}
export const listIdes = () => invoke<IdeEntry[]>("list_ides");
export const setIdePath = (key: string, path: string) =>
  invoke<void>("set_ide_path", { key, path });
export const clearIdePath = (key: string) =>
  invoke<void>("clear_ide_path", { key });
export const addCustomIde = (label: string, path: string) =>
  invoke<string>("add_custom_ide", { label, path });
export const autopopulateIdePaths = () =>
  invoke<string[]>("autopopulate_ide_paths");
export const openIde = (key: string, projectPath: string) =>
  invoke<void>("open_ide", { key, projectPath });

// --- Settings ---
export interface AppSettings {
  vault_path: string;
  vault_dir: string;
  is_default: boolean;
  default_dir: string;
  exe_dir: string;
  legacy_appdata_exists: boolean;
  legacy_appdata_path: string | null;
  idle_timeout_minutes: number;
  idle_timeout_default_minutes: number;
}
export const getSettings = () => invoke<AppSettings>("get_settings");
export const setVaultDir = (dir: string) =>
  invoke<void>("set_vault_dir", { dir });
export const resetVaultDir = () => invoke<void>("reset_vault_dir");
export const setIdleTimeoutMinutes = (minutes: number) =>
  invoke<void>("set_idle_timeout_minutes", { minutes });
export const restartApp = () => invoke<void>("restart_app");
