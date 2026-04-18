import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Container,
  ArrowUp,
  ArrowDown,
  RefreshCcw,
  Hammer,
  Play,
  ScrollText,
  StopCircle,
  TerminalSquare,
  AlertTriangle,
  Download,
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
import { DockerLogDialog } from "./DockerLogDialog";

interface Props {
  sessionId: string;
  projectId: string;
}

/**
 * Docker Compose services for the project. Rendered as a BottomPanel
 * tab. Parses the compose file from disk, merges with `docker compose ps`
 * runtime state, and exposes per-service actions.
 */
export function DockerPanel({ sessionId, projectId }: Props) {
  const [info, setInfo] = useState<DockerInfo | null>(null);
  const [statuses, setStatuses] = useState<ServiceStatus[]>([]);
  const [caps, setCaps] = useState<SessionCapabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const confirm = useConfirm();

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
    return info.services.map((svc) => ({
      svc,
      status: byName.get(svc.name),
    }));
  }, [info, statuses]);

  async function refresh() {
    setBusy(true);
    await Promise.all([loadInfo(), loadPs()]);
    setBusy(false);
  }

  async function runAction(
    action: "up" | "down" | "restart" | "build" | "pull",
    service?: string,
    needsConfirm = false,
  ) {
    if (needsConfirm) {
      const ok = await confirm({
        title: `${action}${service ? ` ${service}` : ""}?`,
        description: (
          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
            docker compose {action}
            {service ? ` ${service}` : ""}
          </div>
        ),
        confirmText: action,
        danger: action === "down",
      });
      if (!ok) return;
    }
    setBusy(true);
    const t = toast.loading(
      `docker compose ${action}${service ? ` ${service}` : ""}…`,
    );
    try {
      const code = await api.dockerComposeAction(
        sessionId,
        projectId,
        action,
        service ?? null,
      );
      toast.success(`exit ${code}`, { id: t });
      await loadPs();
    } catch (e) {
      toast.error(`${e}`, { id: t });
    } finally {
      setBusy(false);
    }
  }

  async function runOneOff(service: string) {
    const ok = await confirm({
      title: `Run one-off: ${service}?`,
      description: (
        <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
          docker compose run --rm --remove-orphans {service}
        </div>
      ),
      confirmText: "Run",
    });
    if (!ok) return;
    setBusy(true);
    const t = toast.loading(`run --rm ${service}…`);
    try {
      const code = await api.dockerComposeAction(
        sessionId,
        projectId,
        "run_rm",
        service,
      );
      toast.success(`exit ${code}`, { id: t });
    } catch (e) {
      toast.error(`${e}`, { id: t });
    } finally {
      setBusy(false);
    }
  }

  function openLogs(service: string) {
    setLogsFor(service);
  }

  async function execShell(service: string) {
    try {
      await api.dockerComposeExecShell(sessionId, projectId, service);
      toast.success(`Opened shell into ${service} — check Terminal tabs`);
    } catch (e) {
      toast.error(`${e}`);
    }
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
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-1 border-b bg-muted/30 p-1.5">
        <Button
          size="sm"
          onClick={() => runAction("up", undefined, false)}
          disabled={busy}
        >
          <ArrowUp className="mr-1 h-3.5 w-3.5" />
          Up all
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => runAction("down", undefined, true)}
          disabled={busy}
        >
          <ArrowDown className="mr-1 h-3.5 w-3.5" />
          Down
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => runAction("restart", undefined, true)}
          disabled={busy}
        >
          <RefreshCcw className="mr-1 h-3.5 w-3.5" />
          Restart all
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => runAction("build")}
          disabled={busy}
        >
          <Hammer className="mr-1 h-3.5 w-3.5" />
          Build
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => runAction("pull")}
          disabled={busy}
        >
          <Download className="mr-1 h-3.5 w-3.5" />
          Pull
        </Button>
        <div className="flex-1" />
        <span className="font-mono text-[10px] text-muted-foreground">
          {caps?.compose_version ?? ""}
        </span>
        <Button size="icon" variant="ghost" onClick={refresh} disabled={busy}>
          <RefreshCcw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
        </Button>
      </div>

      {logsFor && (
        <DockerLogDialog
          sessionId={sessionId}
          projectId={projectId}
          service={logsFor}
          onClose={() => setLogsFor(null)}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Service</th>
              <th className="px-3 py-1.5 text-left font-medium">Image</th>
              <th className="px-3 py-1.5 text-left font-medium">Status</th>
              <th className="px-3 py-1.5 text-right font-medium">Actions</th>
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
                busy={busy}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  svc,
  status,
  onAction,
  onOneOff,
  onOpenLogs,
  onExecShell,
  busy,
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
  busy: boolean;
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
      <td className="px-3 py-1.5 text-right">
        <div className="inline-flex flex-wrap justify-end gap-1">
          {svc.is_oneoff ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={onOneOff}
            >
              <Play className="mr-1 h-3 w-3" />
              Run
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onAction("up", svc.name, false)}
              >
                <ArrowUp className="mr-1 h-3 w-3" />
                Up
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onAction("restart", svc.name, true)}
              >
                <RefreshCcw className="mr-1 h-3 w-3" />
                Restart
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onAction("build", svc.name, false)}
              >
                <Hammer className="mr-1 h-3 w-3" />
                Build
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onOpenLogs}
              >
                <ScrollText className="mr-1 h-3 w-3" />
                Logs
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!isRunning}
                onClick={onExecShell}
              >
                <TerminalSquare className="mr-1 h-3 w-3" />
                Shell
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
