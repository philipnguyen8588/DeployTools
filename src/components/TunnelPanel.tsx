import { useCallback, useEffect, useState } from "react";
import { Cable, Plus, X, RefreshCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { TunnelInfo } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";

interface Props {
  sessionId: string;
}

/**
 * SSH local port forwarding (-L). Each tunnel binds a local port on
 * 127.0.0.1 and forwards it, over the already-authenticated SSH session,
 * to a remote host:port (as seen from the server). Handy for reaching a
 * database or internal dashboard bound to localhost on the remote box.
 */
export function TunnelPanel({ sessionId }: Props) {
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTunnels(await api.listTunnels(sessionId));
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      toast.success(`Tunnel up: 127.0.0.1:${lp} → ${host}:${rp}`);
      setLocalPort("");
      setRemotePort("");
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setStarting(false);
    }
  }

  async function stop(t: TunnelInfo) {
    try {
      await api.stopTunnel(t.id);
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* New-tunnel form */}
      <div className="flex flex-wrap items-end gap-2 border-b bg-muted/30 p-2">
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

      {/* Active tunnel list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tunnels.length === 0 ? (
          <div className="grid h-full place-items-center p-8 text-center text-xs text-muted-foreground">
            <div className="space-y-1">
              <Cable className="mx-auto h-6 w-6 opacity-50" />
              <div>No active tunnels.</div>
              <div>
                Forward a local port to a service reachable from the server
                (e.g. a DB on <span className="font-mono">127.0.0.1</span>).
              </div>
            </div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Local</th>
                <th className="px-3 py-1.5 text-left font-medium">Forwards to</th>
                <th className="w-10 px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {tunnels.map((t) => (
                <tr key={t.id} className="border-b hover:bg-accent">
                  <td className="px-3 py-1.5 font-mono">
                    127.0.0.1:{t.local_port}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">
                    {t.remote_host}:{t.remote_port}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => void stop(t)}
                      title="Stop tunnel"
                    >
                      <X className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
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
