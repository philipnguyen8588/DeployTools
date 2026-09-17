import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Plug,
  Server as ServerIcon,
  ShieldCheck,
  ShieldOff,
  Clock,
  ArrowUp,
  ArrowDown,
  FolderTree,
  GitBranch,
  Bot,
  HardDrive,
} from "lucide-react";

import * as api from "@/lib/api";
import type { DiskUsage } from "@/lib/types";
import { useSessions } from "@/stores/sessions";
import { useServers } from "@/stores/servers";
import { useProjects } from "@/stores/projects";
import { useVault } from "@/stores/vault";
import { cn, formatBytes } from "@/lib/utils";

/**
 * The persistent bottom bar. Renders outside every tab so it's always
 * visible. When a tab is active, it surfaces connection details for
 * that tab's SSH session; otherwise it shows app-level state.
 */
export function StatusBar() {
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const { servers } = useServers();
  const { projects } = useProjects();
  const { unlocked } = useVault();

  const active = tabs.find((t) => t.session.id === activeId) ?? null;
  const server = active
    ? servers.find((s) => s.id === active.session.server_id)
    : undefined;
  const project = active?.session.project_id
    ? projects.find((p) => p.id === active!.session.project_id)
    : undefined;

  // Uptime — tick every second.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // "MCP is working" indicator — driven by `mcp://active` events. Shows
  // the project + tool an AI agent is currently touching, auto-hiding a
  // few seconds after the last event.
  const [mcpActive, setMcpActive] = useState<{
    project: string;
    tool: string;
    at: number;
  } | null>(null);
  useEffect(() => {
    let un: UnlistenFn | null = null;
    (async () => {
      un = await listen<{ project: string; tool: string }>(
        "mcp://active",
        (e) => setMcpActive({ ...e.payload, at: Date.now() }),
      );
    })();
    return () => {
      un?.();
    };
  }, []);
  const mcpVisible = mcpActive != null && nowMs - mcpActive.at < 5000;

  // Bytes transferred — accumulate from sftp-progress events for the
  // active session. Resets when the active session changes.
  const [bytesUp, setBytesUp] = useState(0);
  const [bytesDown, setBytesDown] = useState(0);

  // Git branch of the active project's local repo. Polled every 30 s so
  // branch switches made from a terminal are reflected without the user
  // having to reopen the tab.
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitHead, setGitHead] = useState<string | null>(null);
  useEffect(() => {
    setGitBranch(null);
    setGitHead(null);
    if (!project) return;
    let cancelled = false;
    const load = async () => {
      try {
        const info = await api.gitInfo(project.id);
        if (cancelled) return;
        if (info.is_repo) {
          setGitBranch(info.branch ?? null);
          setGitHead(info.head_short ?? null);
        } else {
          setGitBranch(null);
          setGitHead(null);
        }
      } catch {
        /* repo unreadable — silent */
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [project?.id]);

  // Disk usage of the connected server — loaded ONCE per connection (no
  // polling). Refetched only when the active session id changes or it
  // (re)enters the connected state, e.g. after a reconnect.
  const [disks, setDisks] = useState<DiskUsage[] | null>(null);
  const isConnected = active?.status === "connected";
  const isSshSession = active?.session.protocol === "ssh";
  useEffect(() => {
    setDisks(null);
    if (!active || !isConnected || !isSshSession) return;
    const sid = active.session.id;
    let cancelled = false;
    (async () => {
      try {
        const d = await api.fetchDiskUsage(sid);
        if (!cancelled) setDisks(d);
      } catch {
        /* server without df / non-Linux — silently omit */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.session.id, isConnected, isSshSession]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBytesUp(0);
    setBytesDown(0);
    if (!active) return;
    const sid = active.session.id;
    let un: UnlistenFn | null = null;
    let lastKey = "";
    let lastWritten = 0;
    (async () => {
      un = await listen<{
        phase: "upload" | "download";
        path: string;
        written: number;
        total: number;
      }>(`sftp-progress://${sid}`, (e) => {
        // Each file reports cumulative `written` from 0..total. Detect
        // a new file by (phase, path) change and account only the delta.
        const key = `${e.payload.phase}:${e.payload.path}`;
        const w = e.payload.written;
        const delta = key === lastKey ? w - lastWritten : w;
        lastKey = key;
        lastWritten = w;
        if (delta <= 0) return;
        if (e.payload.phase === "upload") setBytesUp((x) => x + delta);
        else setBytesDown((x) => x + delta);
      });
    })();
    return () => {
      un?.();
    };
  }, [active?.session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The filesystem to headline: prefer root `/`, else the largest by size.
  const primaryDisk =
    disks && disks.length > 0
      ? (disks.find((d) => d.mount === "/") ??
        [...disks].sort((a, b) => b.total_kb - a.total_kb)[0])
      : null;
  const diskPercent =
    primaryDisk && primaryDisk.total_kb > 0
      ? Math.round((primaryDisk.used_kb / primaryDisk.total_kb) * 100)
      : 0;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-card px-3 text-[11px] text-muted-foreground">
      {active && server ? (
        <>
          {/* Connection — user@host:port with a colored dot that mirrors
              the lifecycle state: green = live, amber = reconnecting,
              red = disconnected. */}
          <Item
            icon={
              <span
                className={cn(
                  "inline-block h-2 w-2 rounded-full",
                  active.status === "connected"
                    ? "bg-green-500"
                    : active.status === "reconnecting"
                      ? "animate-pulse bg-yellow-500"
                      : "bg-red-500",
                )}
              />
            }
            tooltip={
              active.status === "connected"
                ? `Connected via ${active.session.protocol.toUpperCase()} (${server.auth_kind} auth)`
                : active.status === "reconnecting"
                  ? "Reconnecting…"
                  : (active.disconnectReason ?? "Disconnected")
            }
          >
            <span className="font-mono">
              {server.user}@{server.host}:{server.port}
            </span>
          </Item>

          {/* Project mapping — local → remote */}
          {project && (
            <>
              <Sep />
              <Item
                icon={<FolderTree className="h-3 w-3" />}
                tooltip="Project mapping (local ↔ remote)"
              >
                <span className="font-mono max-w-[32ch] truncate">
                  {project.name}
                </span>
              </Item>
            </>
          )}

          {/* Current git branch of the project's local repo */}
          {gitBranch && (
            <>
              <Sep />
              <Item
                icon={<GitBranch className="h-3 w-3 text-primary" />}
                tooltip={
                  gitHead ? `Local branch · HEAD ${gitHead}` : "Local branch"
                }
              >
                <span className="font-mono">{gitBranch}</span>
              </Item>
            </>
          )}

          {/* Session uptime */}
          {/* Disk usage of the primary filesystem — loaded once on connect.
              Shown as a mini progress bar (green → amber → red) like the
              Resources tab, with free space alongside. */}
          {primaryDisk && (
            <>
              <Sep />
              <div
                className="flex items-center gap-1.5 whitespace-nowrap"
                title={(disks ?? [])
                  .map(
                    (d) =>
                      `${d.mount}  ${formatBytes(d.used_kb * 1024)} / ${formatBytes(d.total_kb * 1024)} (${d.total_kb > 0 ? Math.round((d.used_kb / d.total_kb) * 100) : 0}%) · ${formatBytes((d.total_kb - d.used_kb) * 1024)} free`,
                  )
                  .join("\n")}
              >
                <HardDrive
                  className={cn(
                    "h-3 w-3",
                    diskPercent > 90
                      ? "text-destructive"
                      : diskPercent > 75
                        ? "text-yellow-500"
                        : "",
                  )}
                />
                <div className="h-1.5 w-16 overflow-hidden rounded bg-muted">
                  <div
                    className={cn(
                      "h-full",
                      diskPercent > 90
                        ? "bg-destructive"
                        : diskPercent > 75
                          ? "bg-yellow-500"
                          : "bg-primary",
                    )}
                    style={{ width: `${diskPercent}%` }}
                  />
                </div>
                <span className="font-mono">
                  {diskPercent}% ·{" "}
                  {formatBytes(
                    (primaryDisk.total_kb - primaryDisk.used_kb) * 1024,
                  )}{" "}
                  free
                </span>
              </div>
            </>
          )}

          {/* Bytes transferred this session — near the end, next to uptime */}
          <Sep />
          <Item icon={<ArrowUp className="h-3 w-3" />} tooltip="Uploaded">
            {formatBytes(bytesUp)}
          </Item>
          <Item icon={<ArrowDown className="h-3 w-3" />} tooltip="Downloaded">
            {formatBytes(bytesDown)}
          </Item>

          {/* Session uptime — last */}
          <Sep />
          <Item icon={<Clock className="h-3 w-3" />} tooltip="Session uptime">
            {formatDuration(nowMs - active.session.opened_at)}
          </Item>
        </>
      ) : (
        <Item
          icon={<Plug className="h-3 w-3 text-muted-foreground" />}
          tooltip="No active session"
        >
          Not connected
        </Item>
      )}

      <div className="flex-1" />

      {/* MCP activity — an AI agent is driving the app right now. */}
      {mcpVisible && mcpActive && (
        <Item
          icon={<Bot className="h-3 w-3 animate-pulse text-primary" />}
          tooltip={`MCP agent is running "${mcpActive.tool}" on ${mcpActive.project}`}
          className="text-primary"
        >
          <span className="max-w-[28ch] truncate">
            MCP: {mcpActive.project} · {mcpActive.tool}
          </span>
        </Item>
      )}

      {/* Right-aligned app-level state */}
      <Item
        icon={<ServerIcon className="h-3 w-3" />}
        tooltip="Servers · open tabs"
      >
        {servers.length} servers · {tabs.length} open
      </Item>

      <Sep />
      <Item
        icon={
          unlocked ? (
            <ShieldCheck className="h-3 w-3 text-green-500" />
          ) : (
            <ShieldOff className="h-3 w-3 text-destructive" />
          )
        }
        tooltip="Vault lock status"
      >
        {unlocked ? "unlocked" : "locked"}
      </Item>
    </footer>
  );
}

/** Thin vertical divider between status-bar items. */
function Sep() {
  return <span className="select-none text-border" aria-hidden>|</span>;
}

function Item({
  icon,
  tooltip,
  children,
  className,
}: {
  icon: React.ReactNode;
  tooltip?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      title={tooltip}
      className={cn("flex items-center gap-1 whitespace-nowrap", className)}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}
