import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Plug,
  PlugZap,
  Server as ServerIcon,
  ShieldCheck,
  ShieldOff,
  TerminalSquare,
  Clock,
  ArrowUp,
  ArrowDown,
  Fingerprint,
  FolderTree,
} from "lucide-react";

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

  // Bytes transferred — accumulate from sftp-progress events for the
  // active session. Resets when the active session changes.
  const [bytesUp, setBytesUp] = useState(0);
  const [bytesDown, setBytesDown] = useState(0);

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

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-card px-3 text-[11px] text-muted-foreground">
      {active && server ? (
        <>
          {/* Connection — user@host:port */}
          <Item
            icon={<PlugZap className="h-3 w-3 text-green-500" />}
            tooltip={`Connected via SSH (${server.auth_kind} auth)`}
          >
            <span className="font-mono">
              {server.user}@{server.host}:{server.port}
            </span>
          </Item>

          {/* Project mapping — local → remote */}
          {project && (
            <Item
              icon={<FolderTree className="h-3 w-3" />}
              tooltip="Project mapping (local ↔ remote)"
            >
              <span className="font-mono max-w-[32ch] truncate">
                {project.name}
              </span>
            </Item>
          )}

          {/* Fingerprint — last 12 chars; hover shows full */}
          {active.session.fingerprint && (
            <Item
              icon={<Fingerprint className="h-3 w-3" />}
              tooltip={active.session.fingerprint}
            >
              <span className="font-mono">
                …{active.session.fingerprint.slice(-12)}
              </span>
            </Item>
          )}

          {/* Active terminals count */}
          <Item
            icon={<TerminalSquare className="h-3 w-3" />}
            tooltip="Open terminal channels in this session"
          >
            {active.session.terminal_count}
          </Item>

          {/* Session uptime */}
          <Item
            icon={<Clock className="h-3 w-3" />}
            tooltip="Session uptime"
          >
            {formatDuration(nowMs - active.session.opened_at)}
          </Item>

          {/* Bytes transferred this session */}
          <Item icon={<ArrowUp className="h-3 w-3" />} tooltip="Uploaded">
            {formatBytes(bytesUp)}
          </Item>
          <Item icon={<ArrowDown className="h-3 w-3" />} tooltip="Downloaded">
            {formatBytes(bytesDown)}
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

      {/* Right-aligned app-level state */}
      <Item
        icon={<ServerIcon className="h-3 w-3" />}
        tooltip="Servers · open tabs"
      >
        {servers.length} servers · {tabs.length} open
      </Item>

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
