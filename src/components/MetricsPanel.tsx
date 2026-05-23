import { useEffect, useMemo, useRef, useState } from "react";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  Clock,
  RefreshCcw,
  Activity,
  ArrowDown,
  ArrowUp,
  Container as ContainerIcon,
} from "lucide-react";
import * as api from "@/lib/api";
import type { Metrics, ProcessInfo } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn, formatBytes } from "@/lib/utils";

interface Props {
  sessionId: string;
  /** Whether this tab is the currently-active one — polling runs only then. */
  active: boolean;
}

type SortKey = "cpu" | "mem" | "rss" | "pid" | "user" | "command" | "container";
type SortDir = "asc" | "desc";

/**
 * Lightweight resources dashboard fed by a single SSH command per tick.
 * The tab must be active to poll; switching away stops the timer so we
 * don't hammer idle sessions.
 *
 * Layout (compact, top-to-bottom):
 *   1. Toolbar: polling indicator + filter + manual refresh
 *   2. Stat strip: one-line CPU / RAM / Net / Uptime chips
 *   3. Process table: sortable by CPU / RAM / PID / user / command
 *   4. Disks + Network interfaces (collapsed into half-width cards)
 */
export function MetricsPanel({ sessionId, active }: Props) {
  const [m, setM] = useState<Metrics | null>(null);
  const [prevNet, setPrevNet] = useState<Map<string, [number, number]>>(
    new Map(),
  );
  const [rate, setRate] = useState<Map<string, [number, number]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
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

  /** Click on a column header → sort by it; second click flips direction. */
  function onSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Numeric columns default to desc (highest first), text columns asc.
      setSortDir(key === "command" || key === "user" ? "asc" : "desc");
    }
  }

  const sortedProcs = useMemo<ProcessInfo[]>(() => {
    if (!m) return [];
    const needle = filter.trim().toLowerCase();
    // Filter also matches the container name / id so users can type a
    // container keyword (e.g. "nginx", or a short container id) to see
    // exactly what's running where.
    const list = needle
      ? m.processes.filter(
          (p) =>
            p.command.toLowerCase().includes(needle) ||
            p.user.toLowerCase().includes(needle) ||
            String(p.pid).includes(needle) ||
            (p.container_name?.toLowerCase().includes(needle) ?? false) ||
            (p.container_id?.toLowerCase().includes(needle) ?? false) ||
            (p.container_kind?.toLowerCase().includes(needle) ?? false),
        )
      : m.processes.slice();
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      switch (sortKey) {
        case "cpu":
          return (a.cpu_percent - b.cpu_percent) * dir;
        case "mem":
          return (a.mem_percent - b.mem_percent) * dir;
        case "rss":
          return (a.rss_kb - b.rss_kb) * dir;
        case "pid":
          return (a.pid - b.pid) * dir;
        case "user":
          return a.user.localeCompare(b.user) * dir;
        case "command":
          return a.command.localeCompare(b.command) * dir;
        case "container": {
          // Containerised procs sort before host procs when ascending.
          // Inside the group, by container_name || container_id for
          // deterministic ordering.
          const aKey = a.container_name || a.container_id || "";
          const bKey = b.container_name || b.container_id || "";
          if (!aKey && !bKey) return 0;
          if (!aKey) return 1 * dir;
          if (!bKey) return -1 * dir;
          return aKey.localeCompare(bKey) * dir;
        }
      }
    });
    return list;
  }, [m, filter, sortKey, sortDir]);

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
  const top = pickTopIface(rate);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar — polling indicator + filter + refresh. */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-2 py-1 text-xs">
        <Activity className="h-3 w-3 text-primary" />
        <span className="text-muted-foreground">Polling 3s</span>
        <div className="flex-1" />
        <Input
          placeholder="Filter processes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-6 w-56 text-xs"
        />
        <Button size="icon-sm" variant="ghost" onClick={tick} disabled={loading}>
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Compact stat strip — 4 chips on a single line. */}
      <div className="grid shrink-0 grid-cols-2 gap-2 p-2 md:grid-cols-4">
        <StatChip
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="CPU"
          value={m.cpu_percent != null ? `${m.cpu_percent.toFixed(0)}%` : "—"}
          bar={m.cpu_percent ?? null}
          sub={
            m.loadavg
              ? `load ${m.loadavg.map((x) => x.toFixed(2)).join(" ")}`
              : undefined
          }
        />
        <StatChip
          icon={<MemoryStick className="h-3.5 w-3.5" />}
          label="RAM"
          value={memUsedPct != null ? `${memUsedPct}%` : "—"}
          bar={memUsedPct}
          sub={
            m.mem_total_kb != null && m.mem_available_kb != null
              ? `${formatBytes((m.mem_total_kb - m.mem_available_kb) * 1024)} / ${formatBytes(m.mem_total_kb * 1024)}`
              : undefined
          }
        />
        <StatChip
          icon={<Network className="h-3.5 w-3.5" />}
          label={top ? `Net ${top.name}` : "Net"}
          value={top ? `↓${rateFmt(top.rx)}` : "—"}
          bar={null}
          sub={top ? `↑${rateFmt(top.tx)}` : "waiting"}
        />
        <StatChip
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Uptime"
          value={m.uptime_secs != null ? fmtUptime(m.uptime_secs) : "—"}
          bar={null}
        />
      </div>

      {/* Process table (sortable) — fills remaining space. */}
      <div className="min-h-0 flex-1 overflow-auto border-t">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground">
            <tr>
              <Th sortKey="pid" label="PID" sortState={{ sortKey, sortDir }} onSort={onSort} align="right" />
              <Th sortKey="user" label="User" sortState={{ sortKey, sortDir }} onSort={onSort} />
              <Th sortKey="cpu" label="CPU%" sortState={{ sortKey, sortDir }} onSort={onSort} align="right" />
              <Th sortKey="mem" label="MEM%" sortState={{ sortKey, sortDir }} onSort={onSort} align="right" />
              <Th sortKey="rss" label="RSS" sortState={{ sortKey, sortDir }} onSort={onSort} align="right" />
              <Th sortKey="container" label="Container" sortState={{ sortKey, sortDir }} onSort={onSort} />
              <Th sortKey="command" label="Command" sortState={{ sortKey, sortDir }} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {sortedProcs.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="py-4 text-center text-muted-foreground"
                >
                  {filter
                    ? "No processes match the filter."
                    : "No process data (`ps` unavailable?)."}
                </td>
              </tr>
            ) : (
              sortedProcs.map((p) => (
                <tr key={p.pid} className="border-t hover:bg-muted/40">
                  <td className="px-2 py-0.5 text-right font-mono text-muted-foreground">
                    {p.pid}
                  </td>
                  <td className="px-2 py-0.5 font-mono text-muted-foreground">
                    {p.user}
                  </td>
                  <td className="px-2 py-0.5 text-right font-mono">
                    <span
                      className={cn(
                        p.cpu_percent >= 80
                          ? "text-destructive"
                          : p.cpu_percent >= 40
                            ? "text-yellow-500"
                            : "",
                      )}
                    >
                      {p.cpu_percent.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-2 py-0.5 text-right font-mono">
                    <span
                      className={cn(
                        p.mem_percent >= 20
                          ? "text-destructive"
                          : p.mem_percent >= 8
                            ? "text-yellow-500"
                            : "",
                      )}
                    >
                      {p.mem_percent.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-2 py-0.5 text-right font-mono text-muted-foreground">
                    {formatBytes(p.rss_kb * 1024)}
                  </td>
                  <td className="px-2 py-0.5">
                    <ContainerBadge p={p} />
                  </td>
                  <td className="max-w-0 truncate px-2 py-0.5 font-mono" title={p.command}>
                    {p.command}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Disks + Network (collapsible-feel by small size). */}
      <div className="grid shrink-0 gap-2 border-t p-2 md:grid-cols-2">
        <MiniSection
          icon={<HardDrive className="h-3 w-3" />}
          title="Disks"
          empty={m.disks.length === 0 ? "No disk data." : undefined}
        >
          {m.disks.map((d) => {
            const pct = Math.round((d.used_kb / d.total_kb) * 100);
            return (
              <div
                key={d.mount + d.fs}
                className="flex items-center gap-2 text-xs"
              >
                <span className="w-24 truncate font-mono" title={d.mount}>
                  {d.mount}
                </span>
                <div className="h-1 flex-1 overflow-hidden rounded bg-muted">
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
                <span className="w-24 text-right font-mono text-muted-foreground">
                  {formatBytes(d.used_kb * 1024)} / {formatBytes(d.total_kb * 1024)}
                </span>
                <span className="w-10 text-right font-mono">{pct}%</span>
              </div>
            );
          })}
        </MiniSection>

        <MiniSection
          icon={<Network className="h-3 w-3" />}
          title="Interfaces"
          empty={m.net.length === 0 ? "No interfaces." : undefined}
        >
          {m.net.map((n) => {
            const r = rate.get(n.name);
            return (
              <div
                key={n.name}
                className="flex items-center gap-2 text-xs font-mono"
              >
                <span className="w-20 truncate">{n.name}</span>
                <span className="w-24 text-right text-muted-foreground">
                  ↓ {r ? rateFmt(r[0]) : "—"}
                </span>
                <span className="w-24 text-right text-muted-foreground">
                  ↑ {r ? rateFmt(r[1]) : "—"}
                </span>
                <span className="flex-1 text-right text-[10px] text-muted-foreground">
                  total {formatBytes(n.rx_bytes)} / {formatBytes(n.tx_bytes)}
                </span>
              </div>
            );
          })}
        </MiniSection>
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

/**
 * Small chip shown in the Container column. Colour-coded by runtime so
 * Docker / K8s / Podman / LXC processes are visually distinguishable.
 * Host processes render as a dim dash — the grey makes containerised
 * rows pop at a glance when you're scrolling a busy process list.
 */
function ContainerBadge({ p }: { p: ProcessInfo }) {
  if (!p.container_kind) {
    return <span className="font-mono text-[10px] text-muted-foreground/60">—</span>;
  }
  const kindColor: Record<string, string> = {
    docker:
      "bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-blue-500/20",
    podman:
      "bg-purple-500/15 text-purple-700 dark:text-purple-300 ring-purple-500/20",
    kubepods:
      "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-indigo-500/20",
    containerd:
      "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 ring-cyan-500/20",
    lxc:
      "bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/20",
  };
  const color = kindColor[p.container_kind] ?? "bg-muted text-muted-foreground";
  // Prefer the friendly docker-ps name; fall back to the short id.
  const label = p.container_name || p.container_id || p.container_kind;
  const titleBits = [
    `Runtime: ${p.container_kind}`,
    p.container_id ? `ID: ${p.container_id}` : null,
    p.container_name ? `Name: ${p.container_name}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      title={titleBits}
      className={cn(
        "inline-flex max-w-[18ch] items-center gap-1 truncate rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset",
        color,
      )}
    >
      <ContainerIcon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Compact stat chip — single row with icon + label + big value + bar. */
function StatChip({
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
    <div className="rounded-md border bg-card px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
        <span className="ml-auto font-mono text-sm font-semibold text-foreground">
          {value}
        </span>
      </div>
      {bar != null && (
        <div className="mt-1 h-1 overflow-hidden rounded bg-muted">
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
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {sub}
        </div>
      )}
    </div>
  );
}

function MiniSection({
  icon,
  title,
  empty,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-card p-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        {icon}
        {title}
      </div>
      {empty ? (
        <p className="text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-0.5">{children}</div>
      )}
    </div>
  );
}

/** Clickable column header with sort indicator. */
function Th({
  sortKey,
  label,
  sortState,
  onSort,
  align = "left",
}: {
  sortKey: SortKey;
  label: string;
  sortState: { sortKey: SortKey; sortDir: SortDir };
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortState.sortKey === sortKey;
  return (
    <th
      className={cn(
        "select-none whitespace-nowrap px-2 py-1 font-medium",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-0.5 hover:text-foreground",
          align === "right" && "ml-auto",
          active && "text-foreground",
        )}
      >
        {label}
        {active &&
          (sortState.sortDir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          ))}
      </button>
    </th>
  );
}

function pickTopIface(
  rate: Map<string, [number, number]>,
): { name: string; rx: number; tx: number } | null {
  let best: { name: string; rx: number; tx: number } | null = null;
  for (const [name, [rx, tx]] of rate) {
    if (!best || rx + tx > best.rx + best.tx) {
      best = { name, rx, tx };
    }
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
