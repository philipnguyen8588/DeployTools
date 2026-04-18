import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cog,
  Play,
  StopCircle,
  RefreshCcw,
  Search,
  Clipboard,
  Info,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { ServiceEntry, SessionCapabilities } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  sessionId: string;
}

/**
 * systemd service listing + per-service start/stop/restart. Rendered as
 * a BottomPanel tab. Surfaces a clear banner if the server doesn't have
 * passwordless sudo configured for systemctl.
 */
export function ServicePanel({ sessionId }: Props) {
  const [items, setItems] = useState<ServiceEntry[]>([]);
  const [caps, setCaps] = useState<SessionCapabilities | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const confirm = useConfirm();

  const refreshCaps = useCallback(async () => {
    try {
      setCaps(await api.sessionCapabilities(sessionId));
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.serviceList(sessionId));
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refreshCaps();
  }, [refreshCaps]);

  useEffect(() => {
    if (caps?.has_systemctl) void refresh();
  }, [caps?.has_systemctl, refresh]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (s) =>
        s.unit.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [items, filter]);

  async function act(
    unit: string,
    action: "start" | "stop" | "restart" | "reload",
  ) {
    const ok = await confirm({
      title: `${action} ${unit}?`,
      confirmText: action,
      danger: action === "stop",
    });
    if (!ok) return;
    setBusyAction(`${unit}:${action}`);
    const t = toast.loading(`${action} ${unit}…`);
    try {
      const code = await api.serviceAction(sessionId, unit, action);
      toast.success(`${unit} ${action} exit ${code}`, { id: t });
      await refresh();
    } catch (e) {
      toast.error(`${e}`, { id: t });
    } finally {
      setBusyAction(null);
    }
  }

  // Error states first.
  if (caps && caps.has_systemctl === false) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        <div>
          <Info className="mx-auto mb-2 h-6 w-6" />
          systemctl not found on this server.
        </div>
      </div>
    );
  }

  const canAct = caps?.is_root || caps?.passwordless_sudo;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b bg-muted/30 p-1.5">
        <Cog className="h-4 w-4 text-primary" />
        <span className="text-xs font-medium">systemd services</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {items.length} running
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 w-48 pl-7 text-xs"
          />
        </div>
        <Button size="icon" variant="ghost" onClick={refresh} disabled={loading}>
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {!canAct && caps && (
        <div className="flex shrink-0 items-start gap-2 border-b bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex-1">
            Actions require passwordless sudo. Create{" "}
            <code className="font-mono">/etc/sudoers.d/deploytools</code>:
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(
                `# /etc/sudoers.d/deploytools\n%${"deploy" /* placeholder group */} ALL=NOPASSWD: /bin/systemctl\n`,
              );
              toast.success("Copied sudoers snippet");
            }}
          >
            <Clipboard className="mr-1 h-3 w-3" />
            Copy
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Unit</th>
              <th className="w-20 px-3 py-1.5 text-left font-medium">Active</th>
              <th className="w-20 px-3 py-1.5 text-left font-medium">Sub</th>
              <th className="px-3 py-1.5 text-left font-medium">
                Description
              </th>
              <th className="w-[220px] px-3 py-1.5 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.unit} className="border-b hover:bg-accent">
                <td className="px-3 py-1.5 font-mono">{s.unit}</td>
                <td
                  className={cn(
                    "px-3 py-1.5",
                    s.active === "active"
                      ? "text-green-600 dark:text-green-400"
                      : "text-muted-foreground",
                  )}
                >
                  {s.active}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{s.sub}</td>
                <td className="max-w-[28ch] truncate px-3 py-1.5 text-muted-foreground">
                  {s.description}
                </td>
                <td className="whitespace-nowrap px-3 py-1 text-right">
                  <div className="inline-flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canAct || busyAction !== null}
                      onClick={() => void act(s.unit, "start")}
                      className="h-6 px-2 text-[11px]"
                    >
                      <Play className="mr-1 h-3 w-3 text-green-600 dark:text-green-400" />
                      Start
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canAct || busyAction !== null}
                      onClick={() => void act(s.unit, "restart")}
                      className="h-6 px-2 text-[11px]"
                    >
                      <RefreshCcw className="mr-1 h-3 w-3 text-yellow-600 dark:text-yellow-400" />
                      Restart
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canAct || busyAction !== null}
                      onClick={() => void act(s.unit, "stop")}
                      className="h-6 px-2 text-[11px]"
                    >
                      <StopCircle className="mr-1 h-3 w-3 text-destructive" />
                      Stop
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && !loading && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            {items.length === 0 ? "No running services." : "No matches."}
          </div>
        )}
      </div>
    </div>
  );
}
