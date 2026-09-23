import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cable,
  Plus,
  RefreshCcw,
  Loader2,
  Play,
  Trash2,
  Save,
  Square as StopIcon,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { TunnelInfo, TunnelDef } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { useTunnels } from "@/stores/tunnels";

interface Props {
  sessionId: string;
  /** Server this session belongs to — saved tunnels are stored per server. */
  serverId: string | null;
}

const rowKey = (lp: number, h: string, rp: number) => `${lp}|${h}|${rp}`;

/** A tunnel row = a saved recipe and/or a live tunnel matching it. */
interface Row {
  def: TunnelDef;
  active: TunnelInfo | null;
  saved: boolean;
}

/**
 * SSH local port forwarding (-L). Each tunnel binds a local port on
 * 127.0.0.1 and forwards it, over the already-authenticated SSH session,
 * to a remote host:port (as seen from the server).
 *
 * Started tunnels are SAVED per server, so on the next launch they show up
 * ready to re-start with one click.
 */
export function TunnelPanel({ sessionId, serverId }: Props) {
  const [active, setActive] = useState<TunnelInfo[]>([]);
  const [saved, setSaved] = useState<TunnelDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [tunnelName, setTunnelName] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listTunnels(sessionId);
      setActive(list);
      // Keep the shared count in sync — drives the highlighted Tunnels
      // tab and the idle-timeout exemption.
      useTunnels.getState().setCount(sessionId, list.length);
      if (serverId) setSaved(await api.listSavedTunnels(serverId));
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId, serverId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Merge saved recipes + live tunnels into one list, keyed by the
  // local/host/port triple; a running tunnel that isn't saved still shows.
  const rows = useMemo<Row[]>(() => {
    const map = new Map<string, Row>();
    for (const d of saved) {
      map.set(rowKey(d.local_port, d.remote_host, d.remote_port), {
        def: d,
        active: null,
        saved: true,
      });
    }
    for (const a of active) {
      const k = rowKey(a.local_port, a.remote_host, a.remote_port);
      const existing = map.get(k);
      if (existing) existing.active = a;
      else
        map.set(k, {
          def: {
            name: "",
            local_port: a.local_port,
            remote_host: a.remote_host,
            remote_port: a.remote_port,
          },
          active: a,
          saved: false,
        });
    }
    return [...map.values()].sort((x, y) => x.def.local_port - y.def.local_port);
  }, [saved, active]);

  async function start() {
    const lp = Number(localPort);
    const rp = Number(remotePort);
    const host = remoteHost.trim() || "127.0.0.1";
    if (!Number.isInteger(lp) || lp < 1 || lp > 65535) {
      toast.error("Enter a valid local port (1–65535)");
      return;
    }
    if (!Number.isInteger(rp) || rp < 1 || rp > 65535) {
      toast.error("Enter a valid remote port (1–65535)");
      return;
    }
    setStarting(true);
    try {
      await api.startTunnel(sessionId, lp, host, rp);
      // Remember it so it's one click next time.
      if (serverId) await api.saveTunnel(serverId, tunnelName.trim(), lp, host, rp);
      toast.success(`Tunnel up: 127.0.0.1:${lp} → ${host}:${rp}`);
      setTunnelName("");
      setLocalPort("");
      setRemotePort("");
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setStarting(false);
    }
  }

  async function startSaved(def: TunnelDef) {
    const k = rowKey(def.local_port, def.remote_host, def.remote_port);
    setBusyKey(k);
    try {
      await api.startTunnel(
        sessionId,
        def.local_port,
        def.remote_host,
        def.remote_port,
      );
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setBusyKey(null);
    }
  }

  async function stop(t: TunnelInfo) {
    const k = rowKey(t.local_port, t.remote_host, t.remote_port);
    setBusyKey(k);
    try {
      await api.stopTunnel(t.id);
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setBusyKey(null);
    }
  }

  /** Start every saved tunnel that isn't already running. */
  async function startAll() {
    const toStart = rows.filter((r) => !r.active);
    if (toStart.length === 0) return;
    setBulkBusy(true);
    try {
      for (const r of toStart) {
        try {
          await api.startTunnel(
            sessionId,
            r.def.local_port,
            r.def.remote_host,
            r.def.remote_port,
          );
        } catch (e) {
          toast.error(`${r.def.name || r.def.local_port}: ${e}`);
        }
      }
      await refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  /** Stop every running tunnel. */
  async function stopAll() {
    if (active.length === 0) return;
    setBulkBusy(true);
    try {
      for (const t of active) {
        try {
          await api.stopTunnel(t.id);
        } catch (e) {
          toast.error(`${e}`);
        }
      }
      await refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  async function removeSaved(def: TunnelDef) {
    if (!serverId) return;
    try {
      await api.deleteSavedTunnel(
        serverId,
        def.local_port,
        def.remote_host,
        def.remote_port,
      );
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function saveActive(def: TunnelDef) {
    if (!serverId) return;
    try {
      await api.saveTunnel(
        serverId,
        def.name,
        def.local_port,
        def.remote_host,
        def.remote_port,
      );
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  /** Set/change a tunnel's label. Upserts by the local/host/port triple,
   *  so it also saves a running-but-unsaved tunnel. */
  async function renameTunnel(def: TunnelDef, name: string) {
    if (!serverId) return;
    if (name.trim() === def.name) return;
    try {
      await api.saveTunnel(
        serverId,
        name.trim(),
        def.local_port,
        def.remote_host,
        def.remote_port,
      );
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* New-tunnel form */}
      <div className="flex flex-wrap items-end gap-2 border-b bg-muted/30 p-2">
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          disabled={bulkBusy || rows.every((r) => r.active)}
          onClick={() => void startAll()}
          title="Start every saved tunnel that isn't running"
        >
          {bulkBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          )}
          Start all
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          disabled={bulkBusy || active.length === 0}
          onClick={() => void stopAll()}
          title="Stop every running tunnel"
        >
          <StopIcon className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
          Stop all
        </Button>
        <div className="mx-1 h-8 w-px self-center bg-border" />
        <Field label="Name">
          <Input
            value={tunnelName}
            onChange={(e) => setTunnelName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void start()}
            placeholder="MariaDB"
            className="h-6 w-28 text-xs"
          />
        </Field>
        <Field label="Local port">
          <Input
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && void start()}
            placeholder="15432"
            className="h-6 w-24 font-mono text-xs"
          />
        </Field>
        <span className="pb-1 text-muted-foreground">→</span>
        <Field label="Remote host">
          <Input
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void start()}
            placeholder="127.0.0.1"
            className="h-6 w-40 font-mono text-xs"
          />
        </Field>
        <Field label="Remote port">
          <Input
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && void start()}
            placeholder="5432"
            className="h-6 w-24 font-mono text-xs"
          />
        </Field>
        <Button
          size="sm"
          onClick={() => void start()}
          disabled={starting}
          className="h-6 gap-1 px-2 text-xs"
        >
          {starting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          Start tunnel
        </Button>
        <div className="ml-auto">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void refresh()}
            title="Refresh"
          >
            <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Running banner — session is exempt from idle auto-disconnect. */}
      {active.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs text-green-600 dark:text-green-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
          <span className="font-medium">
            {active.length} tunnel{active.length > 1 ? "s" : ""} running
          </span>
          <span className="text-green-600/70 dark:text-green-400/70">
            · session will not auto-disconnect while tunnels are active
          </span>
        </div>
      )}

      {/* Saved + active tunnel list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="grid h-full place-items-center p-8 text-center text-xs text-muted-foreground">
            <div className="space-y-1">
              <Cable className="mx-auto h-6 w-6 opacity-50" />
              <div>No tunnels yet.</div>
              <div>
                Forward a local port to a service reachable from the server
                (e.g. a DB on <span className="font-mono">127.0.0.1</span>).
                Started tunnels are saved for next time.
              </div>
            </div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
              <tr>
                <th className="w-[92px] px-3 py-1.5 text-left font-medium">
                  Actions
                </th>
                <th className="px-3 py-1.5 text-left font-medium">Name</th>
                <th className="px-3 py-1.5 text-left font-medium">Local</th>
                <th className="px-3 py-1.5 text-left font-medium">Forwards to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const k = rowKey(
                  r.def.local_port,
                  r.def.remote_host,
                  r.def.remote_port,
                );
                const running = r.active != null;
                const busy = busyKey === k;
                return (
                  <tr key={k} className="border-b hover:bg-accent">
                    <td className="whitespace-nowrap px-3 py-1">
                      <div className="inline-flex items-center gap-1">
                        {running ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void stop(r.active!)}
                            className="h-6 w-6 p-0"
                            title="Stop tunnel"
                          >
                            {busy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <StopIcon className="h-3 w-3 text-red-600 dark:text-red-400" />
                            )}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void startSaved(r.def)}
                            className="h-6 w-6 p-0"
                            title="Start tunnel"
                          >
                            {busy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Play className="h-3 w-3 text-green-600 dark:text-green-400" />
                            )}
                          </Button>
                        )}
                        {r.saved ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void removeSaved(r.def)}
                            className="h-6 w-6 p-0"
                            title="Remove saved tunnel"
                          >
                            <Trash2 className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void saveActive(r.def)}
                            className="h-6 w-6 p-0"
                            title="Save this tunnel for next time"
                          >
                            <Save className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1">
                      <input
                        key={`${k}:${r.def.name}`}
                        defaultValue={r.def.name}
                        placeholder="name…"
                        title="Click to name this tunnel (e.g. MariaDB)"
                        onBlur={(e) => void renameTunnel(r.def, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        className="w-28 rounded bg-transparent px-1 py-0.5 text-xs outline-none hover:bg-background focus:bg-background focus:ring-1 focus:ring-ring"
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono">
                      <span
                        className={cn(
                          "mr-2 inline-block h-2 w-2 rounded-full align-middle",
                          running ? "bg-green-500" : "bg-muted-foreground/40",
                        )}
                        title={running ? "Running" : "Stopped"}
                      />
                      127.0.0.1:{r.def.local_port}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">
                      {r.def.remote_host}:{r.def.remote_port}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
