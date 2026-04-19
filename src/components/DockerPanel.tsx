import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Container,
  ArrowUp,
  RefreshCcw,
  Hammer,
  Play,
  ScrollText,
  TerminalSquare,
  AlertTriangle,
  Square as StopIcon,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type {
  ComposeService,
  DockerInfo,
  ServiceStatus,
  SessionCapabilities,
} from "@/lib/types";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { useConfirm } from "./ConfirmDialog";
import { useProjects } from "@/stores/projects";

interface Props {
  sessionId: string;
  projectId: string;
  /** Filter query lifted to the shared BottomPanel tab-strip toolbar. */
  filter?: string;
  /** Bump this to force a reload (used by the shared Refresh button).
   *  Initial mount also loads, so 0 is fine as the starting value. */
  refreshNonce?: number;
  /** Reports `busy` state back to the parent so the shared toolbar can
   *  show the spinning refresh icon. */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * Docker Compose services for the project. Rendered as a BottomPanel
 * tab. Parses the compose file from disk, merges with `docker compose ps`
 * runtime state, and exposes per-service actions.
 */
export function DockerPanel({
  sessionId,
  projectId,
  filter = "",
  refreshNonce = 0,
  onBusyChange,
}: Props) {
  const [info, setInfo] = useState<DockerInfo | null>(null);
  const [statuses, setStatuses] = useState<ServiceStatus[]>([]);
  const [caps, setCaps] = useState<SessionCapabilities | null>(null);
  const confirm = useConfirm();
  const project = useProjects((s) =>
    s.projects.find((p) => p.id === projectId),
  );
  /** Remote working directory where `docker compose …` should run. */
  const remoteDir = project?.remote_path ?? null;

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api.dockerComposeInfo(projectId));
    } catch (e) {
      toast.error(`docker info: ${e}`);
    }
  }, [projectId]);

  const loadPs = useCallback(async () => {
    try {
      const r = await api.dockerComposePs(sessionId, projectId);
      setStatuses(r);
    } catch (e) {
      toast.error(`docker ps: ${e}`);
    }
  }, [sessionId, projectId]);

  const loadCaps = useCallback(async () => {
    try {
      setCaps(await api.sessionCapabilities(sessionId));
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  useEffect(() => {
    void loadInfo();
    void loadCaps();
  }, [loadInfo, loadCaps]);

  useEffect(() => {
    if (info?.detected && caps?.compose_v2) void loadPs();
  }, [info?.detected, caps?.compose_v2, loadPs]);

  const rows = useMemo(() => {
    if (!info) return [];
    const byName = new Map(statuses.map((s) => [s.service, s]));
    const all = info.services.map((svc) => ({
      svc,
      status: byName.get(svc.name),
    }));
    // Sort: running first → other-state → not-created/one-off → alpha.
    const rank = (r: (typeof all)[number]) => {
      if (r.status?.state === "running") return 0;
      if (r.status && r.status.state !== "running") return 1;
      if (r.svc.is_oneoff) return 3;
      return 2;
    };
    all.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.svc.name.localeCompare(b.svc.name);
    });

    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.svc.name.toLowerCase().includes(q) ||
        (r.svc.image?.toLowerCase().includes(q) ?? false) ||
        (r.status?.state.toLowerCase().includes(q) ?? false),
    );
  }, [info, statuses, filter]);

  async function refresh() {
    onBusyChange?.(true);
    try {
      await Promise.all([loadInfo(), loadPs()]);
    } finally {
      onBusyChange?.(false);
    }
  }

  // External "Refresh" trigger from the BottomPanel toolbar.
  useEffect(() => {
    if (refreshNonce <= 0) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  /**
   * Build the argv string for a Compose action and open a new terminal
   * tab that runs it. Moving every action to the terminal (instead of a
   * background exec) gives the user live, scrollable output, the ability
   * to Ctrl+C, and a familiar "watch it run" workflow.
   */
  function runInTerminal(args: {
    action: string;
    tail: string; // the full `docker compose …` argv after `compose`
    label: string;
    confirmText?: string;
    dangerConfirm?: boolean;
    confirmDescription?: React.ReactNode;
  }) {
    const cd = remoteDir ? `cd ${shellQuote(remoteDir)} && ` : "";
    const cmd = `${cd}docker compose ${args.tail}`;
    const spawn = () => {
      window.dispatchEvent(
        new CustomEvent("open-terminal", {
          detail: {
            sessionId,
            label: args.label,
            seed: cmd,
          },
        }),
      );
    };
    if (args.confirmText) {
      void confirm({
        title: `${args.action}?`,
        description:
          args.confirmDescription ?? (
            <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
              {cmd}
            </div>
          ),
        confirmText: args.confirmText,
        danger: args.dangerConfirm,
      }).then((ok) => {
        if (ok) spawn();
      });
    } else {
      spawn();
    }
  }

  async function runAction(
    action: "up" | "down" | "restart" | "build" | "pull",
    service?: string,
    needsConfirm = false,
  ) {
    // Build `up -d <svc>` / `restart <svc>` / `stop <svc>` / `build <svc>` /
    // `pull <svc>` / `down` tails. `up` always takes `-d` so the command
    // returns quickly; the user watches logs via Logs button if needed.
    const svc = service ?? "";
    let tail: string;
    switch (action) {
      case "up":
        tail = svc ? `up ${shellQuote(svc)} -d` : `up -d`;
        break;
      case "down":
        tail = "down";
        break;
      default:
        tail = svc ? `${action} ${shellQuote(svc)}` : action;
    }
    const label = service ? `${action}: ${service}` : `compose: ${action}`;
    runInTerminal({
      action: `compose ${action}${service ? ` ${service}` : ""}`,
      tail,
      label,
      confirmText: needsConfirm ? action : undefined,
      dangerConfirm: action === "down",
    });
  }

  async function runOneOff(service: string) {
    runInTerminal({
      action: `run --rm ${service}`,
      tail: `run --rm --remove-orphans ${shellQuote(service)}`,
      label: `run: ${service}`,
      confirmText: "Run",
    });
  }

  function runStop(service: string) {
    runInTerminal({
      action: `stop ${service}`,
      tail: `stop ${shellQuote(service)}`,
      label: `stop: ${service}`,
    });
  }

  /**
   * Open a new terminal tab and run `docker compose logs -f <service> -n 100`
   * inside it. The user can stop with Ctrl+C or by closing the tab —
   * nothing streams into the Activity feed.
   */
  function openLogs(service: string) {
    if (!info?.compose_path) {
      toast.error("Compose file not loaded yet");
      return;
    }
    // Prefer cd'ing into the compose directory on the REMOTE — we
    // approximate it from the project record we already have. A mild
    // limitation: the sub-directory case (compose_file override) is
    // resolved remotely, so we also fall back to `-f <compose_file>`
    // if cd alone doesn't work. Keep it simple: cd to remote root.
    const cd = remoteDir ? `cd ${shellQuote(remoteDir)} && ` : "";
    const cmd = `${cd}docker compose logs -f ${shellQuote(service)} -n 100`;
    window.dispatchEvent(
      new CustomEvent("open-terminal", {
        detail: {
          sessionId,
          label: `logs: ${service}`,
          seed: cmd,
        },
      }),
    );
  }

  /**
   * Open a new terminal tab running an interactive shell inside the
   * container. We try `bash` and fall back to `sh` at the container
   * level (Alpine images only have `sh`).
   */
  function execShell(service: string) {
    const cd = remoteDir ? `cd ${shellQuote(remoteDir)} && ` : "";
    const seed =
      `${cd}docker compose exec ${shellQuote(service)} ` +
      `sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
    window.dispatchEvent(
      new CustomEvent("open-terminal", {
        detail: {
          sessionId,
          label: `shell: ${service}`,
          seed,
        },
      }),
    );
  }

  // --- empty / error states ---
  if (!info) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading docker info…
      </div>
    );
  }
  if (!info.detected) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        <div>
          <Container className="mx-auto mb-2 h-6 w-6" />
          No <code className="font-mono">docker-compose.yml</code> found in the
          project's local folder.
        </div>
      </div>
    );
  }
  if (caps && caps.compose_v2 === false) {
    const isV1 = caps.compose_v1 === true;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <AlertTriangle className="h-6 w-6 text-yellow-500" />
        <div className="max-w-md text-xs text-yellow-600 dark:text-yellow-400">
          {isV1 ? (
            <>
              Found <code className="font-mono">docker-compose</code> (V1
              legacy). This app requires <strong>Docker Compose V2</strong>.
              <div className="mt-2 font-mono">
                sudo apt install docker-compose-plugin
              </div>
              <div className="mt-1">
                (Ubuntu/Debian; use your distro's equivalent otherwise.)
              </div>
            </>
          ) : (
            <>
              Docker Compose V2 not found on the server.
              <div className="mt-2 font-mono">
                sudo apt install docker-compose-plugin
              </div>
            </>
          )}
        </div>
        {caps.probe_stderr && (
          <details className="w-full max-w-xl text-left text-[11px] text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">
              Diagnostic output
            </summary>
            <pre className="mt-1 max-h-40 overflow-y-auto rounded bg-muted/40 p-2 font-mono">
              {caps.probe_stderr}
            </pre>
          </details>
        )}
        <Button size="sm" variant="outline" onClick={loadCaps}>
          <RefreshCcw className="mr-1 h-3.5 w-3.5" />
          Re-probe
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar — safe actions only (refresh + filter). Mutating
          project-wide commands (`up all`, `down`, `restart all`, …)
          were removed because a single misclick can nuke running
          services. Use the per-service buttons. */}
      {/* Top bar removed — title, filter and refresh now live on the
          shared BottomPanel tab strip (right side). */}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Service</th>
              <th className="px-3 py-1.5 text-left font-medium">Image</th>
              <th className="px-3 py-1.5 text-left font-medium">Status</th>
              <th className="w-[400px] px-3 py-1.5 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ svc, status }) => (
              <Row
                key={svc.name}
                svc={svc}
                status={status}
                onAction={runAction}
                onOneOff={() => runOneOff(svc.name)}
                onOpenLogs={() => openLogs(svc.name)}
                onExecShell={() => execShell(svc.name)}
                onStop={() => runStop(svc.name)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Minimal POSIX single-quote for a shell-seeded command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function Row({
  svc,
  status,
  onAction,
  onOneOff,
  onOpenLogs,
  onExecShell,
  onStop,
}: {
  svc: ComposeService;
  status?: ServiceStatus;
  onAction: (
    action: "up" | "down" | "restart" | "build" | "pull",
    service?: string,
    needsConfirm?: boolean,
  ) => void;
  onOneOff: () => void;
  onOpenLogs: () => void;
  onExecShell: () => void;
  onStop: () => void;
}) {
  const isRunning = status?.state === "running";
  return (
    <tr className="border-b hover:bg-accent">
      <td className="px-3 py-1.5 font-semibold">
        <span className="flex items-center gap-2">
          {svc.name}
          {svc.is_oneoff && (
            <span
              className="rounded bg-blue-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-700 dark:text-blue-400"
              title={
                svc.explicit_oneoff
                  ? "Marked x-deploytools.oneoff = true"
                  : svc.profiles.length > 0
                    ? `Profile: ${svc.profiles.join(", ")}`
                    : "restart: no"
              }
            >
              one-off
            </span>
          )}
          {svc.has_unresolved_vars && (
            <span
              className="rounded bg-yellow-500/20 px-1.5 py-0.5 font-mono text-[10px] text-yellow-700 dark:text-yellow-400"
              title="Contains ${VAR} — resolved at runtime by docker"
            >
              $var
            </span>
          )}
        </span>
      </td>
      <td className="max-w-[20ch] truncate px-3 py-1.5 font-mono text-muted-foreground">
        {svc.image || svc.build || "—"}
      </td>
      <td className="px-3 py-1.5">
        {!status ? (
          <span className="text-muted-foreground">not created</span>
        ) : (
          <span
            className={cn(
              "inline-flex items-center gap-1.5",
              isRunning
                ? "text-green-600 dark:text-green-400"
                : status.state === "exited"
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                isRunning
                  ? "bg-green-500"
                  : status.state === "exited"
                    ? "bg-red-500"
                    : "bg-muted-foreground",
              )}
            />
            {status.state || "?"}
            {status.health && (
              <span className="ml-1 text-[10px] text-muted-foreground">
                ({status.health})
              </span>
            )}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-1 text-right">
        <div className="inline-flex items-center justify-end gap-1">
          {svc.is_oneoff ? (
            <Button
              size="sm"
              onClick={onOneOff}
              className="h-6 px-2 text-[11px]"
              title="Opens a terminal running `docker compose run --rm <svc>`"
            >
              <Play className="mr-1 h-3 w-3 text-green-400" />
              Run
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAction("up", svc.name, false)}
                className="h-6 px-2 text-[11px]"
                title="Opens a terminal running `docker compose up <svc> -d`"
              >
                <ArrowUp className="mr-1 h-3 w-3 text-green-600 dark:text-green-400" />
                Up
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAction("restart", svc.name, false)}
                className="h-6 px-2 text-[11px]"
                title="Opens a terminal running `docker compose restart <svc>`"
              >
                <RefreshCcw className="mr-1 h-3 w-3 text-yellow-600 dark:text-yellow-400" />
                Restart
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!isRunning}
                onClick={onStop}
                className="h-6 px-2 text-[11px]"
                title="Opens a terminal running `docker compose stop <svc>`"
              >
                <StopIcon className="mr-1 h-3 w-3 text-red-600 dark:text-red-400" />
                Stop
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAction("build", svc.name, false)}
                className="h-6 px-2 text-[11px]"
                title="Opens a terminal running `docker compose build <svc>`"
              >
                <Hammer className="mr-1 h-3 w-3 text-orange-600 dark:text-orange-400" />
                Build
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onOpenLogs}
                className="h-6 px-2 text-[11px]"
              >
                <ScrollText className="mr-1 h-3 w-3 text-blue-600 dark:text-blue-400" />
                Logs
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!isRunning}
                onClick={onExecShell}
                className="h-6 px-2 text-[11px]"
              >
                <TerminalSquare className="mr-1 h-3 w-3 text-purple-600 dark:text-purple-400" />
                Shell
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
