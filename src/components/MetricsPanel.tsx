import { useEffect, useRef, useState } from "react";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  Clock,
  RefreshCcw,
  Activity,
} from "lucide-react";
import * as api from "@/lib/api";
import type { Metrics } from "@/lib/types";
import { Button } from "./ui/button";
import { cn, formatBytes } from "@/lib/utils";

interface Props {
  sessionId: string;
  /** Whether this tab is the currently-active one — polling runs only then. */
  active: boolean;
}

/**
 * Lightweight resources dashboard fed by a single SSH command per tick.
 * The tab must be active to poll; switching away stops the timer so we
 * don't hammer idle sessions.
 */
export function MetricsPanel({ sessionId, active }: Props) {
  const [m, setM] = useState<Metrics | null>(null);
  const [prevNet, setPrevNet] = useState<Map<string, [number, number]>>(
    new Map(),
  );
  const [rate, setRate] = useState<Map<string, [number, number]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const prevSampleAt = useRef<number>(0);

  async function tick() {
    setLoading(true);
    try {
      const fresh = await api.fetchMetrics(sessionId);
      // Compute network rate vs previous sample.
      const now = Date.now();
      const dt = prevSampleAt.current
        ? Math.max(1, (now - prevSampleAt.current) / 1000)
        : 0;
      prevSampleAt.current = now;
      const newRate = new Map<string, [number, number]>();
      const newPrev = new Map<string, [number, number]>();
      for (const n of fresh.net) {
        const prev = prevNet.get(n.name);
        if (prev && dt > 0) {
          const rx = Math.max(0, (n.rx_bytes - prev[0]) / dt);
          const tx = Math.max(0, (n.tx_bytes - prev[1]) / dt);
          newRate.set(n.name, [rx, tx]);
        }
        newPrev.set(n.name, [n.rx_bytes, n.tx_bytes]);
      }
      setPrevNet(newPrev);
      setRate(newRate);
      setM(fresh);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId]);

  if (!active && !m) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Open this tab to start polling metrics.
      </div>
    );
  }

  if (error && !m) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        <div>
          <Activity className="mx-auto mb-2 h-6 w-6" />
          {error}
          <Button size="sm" variant="outline" className="mt-2" onClick={tick}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!m) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <RefreshCcw className="mr-2 h-4 w-4 animate-spin" />
        Sampling…
      </div>
    );
  }

  const memUsedPct =
    m.mem_total_kb && m.mem_available_kb
      ? Math.round(
          ((m.mem_total_kb - m.mem_available_kb) / m.mem_total_kb) * 100,
        )
      : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 p-1.5 text-xs">
        <Activity className="h-3.5 w-3.5 text-primary" />
        <span>Polling every 3s while active</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={tick} disabled={loading}>
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 md:grid-cols-2 lg:grid-cols-4">
        {/* CPU */}
        <Card
          icon={<Cpu className="h-4 w-4" />}
          label="CPU"
          value={m.cpu_percent != null ? `${m.cpu_percent.toFixed(0)}%` : "—"}
          bar={m.cpu_percent ?? null}
          sub={
            m.loadavg
              ? `Load ${m.loadavg.map((x) => x.toFixed(2)).join(" · ")}`
              : undefined
          }
        />
        {/* RAM */}
        <Card
          icon={<MemoryStick className="h-4 w-4" />}
          label="RAM"
          value={memUsedPct != null ? `${memUsedPct}%` : "—"}
          bar={memUsedPct}
          sub={
            m.mem_total_kb != null && m.mem_available_kb != null
              ? `${formatBytes((m.mem_total_kb - m.mem_available_kb) * 1024)} / ${formatBytes(m.mem_total_kb * 1024)}`
              : undefined
          }
        />
        {/* Uptime */}
        <Card
          icon={<Clock className="h-4 w-4" />}
          label="Uptime"
          value={m.uptime_secs != null ? fmtUptime(m.uptime_secs) : "—"}
          bar={null}
        />
        {/* Network (top interface by rate) */}
        {(() => {
          const top = pickTopIface(rate);
          if (!top) {
            return (
              <Card
                icon={<Network className="h-4 w-4" />}
                label="Network"
                value="—"
                bar={null}
                sub="waiting for delta"
              />
            );
          }
          return (
            <Card
              icon={<Network className="h-4 w-4" />}
              label={`Net (${top.name})`}
              value={`↓${rateFmt(top.rx)} · ↑${rateFmt(top.tx)}`}
              bar={null}
            />
          );
        })()}

        {/* Disks */}
        <div className="rounded-lg border bg-card p-3 md:col-span-2 lg:col-span-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <HardDrive className="h-4 w-4" />
            Disks
          </div>
          {m.disks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No disk data.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">Mount</th>
                  <th className="py-1 text-left font-medium">FS</th>
                  <th className="py-1 text-right font-medium">Used</th>
                  <th className="py-1 text-right font-medium">Total</th>
                  <th className="py-1 text-left font-medium">Usage</th>
                </tr>
              </thead>
              <tbody>
                {m.disks.map((d) => {
                  const pct = Math.round((d.used_kb / d.total_kb) * 100);
                  return (
                    <tr key={d.mount + d.fs} className="border-t">
                      <td className="py-1 font-mono">{d.mount}</td>
                      <td className="py-1 font-mono text-muted-foreground">
                        {d.fs}
                      </td>
                      <td className="py-1 text-right">
                        {formatBytes(d.used_kb * 1024)}
                      </td>
                      <td className="py-1 text-right">
                        {formatBytes(d.total_kb * 1024)}
                      </td>
                      <td className="py-1 pr-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                            <div
                              className={cn(
                                "h-full",
                                pct > 90
                                  ? "bg-destructive"
                                  : pct > 75
                                    ? "bg-yellow-500"
                                    : "bg-primary",
                              )}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-10 text-right font-mono">
                            {pct}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* All network interfaces */}
        {rate.size > 0 && (
          <div className="rounded-lg border bg-card p-3 md:col-span-2 lg:col-span-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Network className="h-4 w-4" />
              Network interfaces
            </div>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">Interface</th>
                  <th className="py-1 text-right font-medium">RX rate</th>
                  <th className="py-1 text-right font-medium">TX rate</th>
                  <th className="py-1 text-right font-medium">Total RX</th>
                  <th className="py-1 text-right font-medium">Total TX</th>
                </tr>
              </thead>
              <tbody>
                {m.net.map((n) => {
                  const r = rate.get(n.name);
                  return (
                    <tr key={n.name} className="border-t">
                      <td className="py-1 font-mono">{n.name}</td>
                      <td className="py-1 text-right">
                        {r ? rateFmt(r[0]) : "—"}
                      </td>
                      <td className="py-1 text-right">
                        {r ? rateFmt(r[1]) : "—"}
                      </td>
                      <td className="py-1 text-right font-mono text-muted-foreground">
                        {formatBytes(n.rx_bytes)}
                      </td>
                      <td className="py-1 text-right font-mono text-muted-foreground">
                        {formatBytes(n.tx_bytes)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {m.raw && (
        <div className="shrink-0 border-t bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400">
          Could not parse metrics — server may not be Linux / doesn't expose
          /proc. Raw output shown below:
          <pre className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px]">
            {m.raw}
          </pre>
        </div>
      )}
    </div>
  );
}

function Card({
  icon,
  label,
  value,
  bar,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  bar: number | null;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-mono text-xl font-semibold">{value}</div>
      {bar != null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
          <div
            className={cn(
              "h-full",
              bar > 90
                ? "bg-destructive"
                : bar > 75
                  ? "bg-yellow-500"
                  : "bg-primary",
            )}
            style={{ width: `${Math.min(100, bar)}%` }}
          />
        </div>
      )}
      {sub && (
        <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

function pickTopIface(
  rate: Map<string, [number, number]>,
): { name: string; rx: number; tx: number } | null {
  let best: { name: string; rx: number; tx: number } | null = null;
  for (const [name, [rx, tx]] of rate) {
    const total = rx + tx;
    if (!best || rx + tx > best.rx + best.tx) {
      best = { name, rx, tx };
    }
    void total;
  }
  return best;
}

function rateFmt(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}

function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
